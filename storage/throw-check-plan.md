# tscheck `throws` channel — Typed Errors for Plain TS

The first and driving channel of tscheck (see `tscheck-kernel-plan.md` for the
kernel, config, cache, CLI/LS-plugin frontends, and shared locked decisions —
this document specs only what is throws-specific).

**The port:** Effect's error channel `E` tells you *which* errors a computation
can fail with, and makes handling them exhaustively checkable. This channel
recovers that for plain TS: every reached function gets an inferred **escape set**
of error types, diagnostics fire where an effect escapes to an entry point or
handler boundary uncaught, hovers show `throws: ValidationError | RangeError`,
and catch blocks get Effect-`catchTag`-style precision — a catch that handles
`ValidationError` and rethrows the rest subtracts exactly that type.

This is strictly stronger than the earlier boolean "clean/unclean" design and
costs little more: the analysis walk is identical; only the lattice is richer.
The typed sets are what make diagnostics actionable ("escapes `TimeoutError`
from redis.get — add a retry or a sink") instead of "something may throw."

## Summary lattice

Per function: an escape set of error type references (canonical `TypeChecker`
type identities), plus the kernel-standard conditional part (effects inherited
from callback params).

```
ThrowsSummary = {
  escapes: Set<ErrorTypeRef> | TOP     // TOP = "unknown error" (⊤)
  fromCallbacks: Set<paramIndex>       // kernel conditional-summary contract
}
```

- `join` = set union; `TOP` absorbs.
- **Widening (termination + noise control):** sets cap at 8 distinct types; on
  overflow, widen to `TOP`. Fixpoint iterations that keep growing a set widen
  after 3 rounds. `TOP` renders as "an unknown error" in diagnostics.
- Type identity: the declared class/type of the thrown expression, resolved via
  the checker. `throw new Foo()` contributes `Foo`. `throw expr` of union type
  contributes each member. Thrown `any`/`unknown` contributes `TOP`. Subtyping
  is respected on subtraction: catching `Foo` also discharges `SubFoo`.

## Effect sources

1. **Explicit `throw`** — contributes the thrown expression's type.
2. **Propagation** — a call whose resolved summary (after conditional-summary
   resolution) has a non-empty escape set, not under a sink, contributes that set.
3. **Untyped boundary** — a call into untyped JS or an `any`-typed target
   contributes per the `untypedDependencies` policy (below).
4. **`@throws` declarations** — JSDoc `@throws {Foo}` on a function is taken as
   part of its summary AND checked: if inference finds escapes not covered by
   the declared set, that's a diagnostic on the function ("throws `Bar` but
   declares only `Foo`") — lightweight checked exceptions, opt-in per function
   by simply writing the tag.
5. **(strict mode, off by default)** TS unsoundness holes — `as`, `!`, bivariant
   callbacks, unchecked index access. Default: trust TS.

Null-dereference is **never** modeled — that is `strictNullChecks`' job. Sync
only in M1; the async channel (`await` converts rejection→throw, floating
promises, `.catch` sinks, `Promise.all/race` composition) is M4 in its entirety.

## Sinks (typed subtraction)

- **`try/catch`**: subtracts from the try-block's escape set exactly the types
  the catch **discharges**. A catch discharges everything it can reach minus
  what it rethrows: rethrow of the catch binding on some path (data-flow from
  the binding to a `throw`) under an `instanceof T` narrowing rethrows the
  narrowed remainder — so `if (e instanceof Foo) { handle } else { throw e }`
  discharges `Foo` and propagates the rest, precisely. Unconditional rethrow
  discharges nothing. Conditional rethrow not resolvable by TS narrowing =
  rethrows all (conservative). Wrap-and-throw (`throw new AppError(e)`)
  discharges the original set and contributes `AppError` at the catch site.
- **`finally`**: never a sink; a throwing `finally` is a source that escapes
  even when the catch handled everything (JS semantics: it replaces the
  in-flight completion).
- **Configured sinks** (kernel `handlerBoundaries`/`sinks` config): absorb the
  full set, or a declared subset (`"absorbs": ["HttpError"]`) — an error
  middleware that only handles `HttpError` still leaks everything else.

Guards/narrowing honored exactly as TS narrows — no separate guard analyzer.

## Untyped-dependency policy

`channels.throws.untypedDependencies` (default `strict`) + per-package
`overrides`:

- **`strict`** — any use site of an untyped JS dep is a diagnostic.
- **`analyze`** — infer over the dep's JS via `allowJs`/`checkJs`, same engine,
  contributing `TOP` where inference bottoms out to `any`. Cached per
  `pkg@version`. Log analyzed surface (watch transitive pull-in).
- **`trust`** — contributes nothing.

## Overlay entries

Throws-channel overlay entries carry typed sets and conditionality:

```jsonc
"lib.es5": {
  "JSON.parse":      { "throws": ["SyntaxError"] },
  "Array#map":       { "throwsFromCallbacks": [0] },
  "decodeURIComponent": { "throws": ["URIError"] }
}
```

The base overlay must cover the high-frequency stdlib **before** the M1 noise
review (JSON, URL, encode/decode, RegExp construction, iteration protocol,
structuredClone, BigInt/Number conversions, Map/Set/Array HOFs), because the
noise measurement is meaningless without it. Unmodeled leaves: no-effect + log
(kernel contract).

## Diagnostics

At the **unsunk call site** (or `throw` statement) whose effect escapes, with
the typed set in the message and the escape chain as related locations:

```
src/jobs/sync.ts:41 — call may throw SyntaxError (from JSON.parse) with no
catch on the path to handler `onMessage` (src/ws.ts:88)
```

Hover (LS plugin) on any function shows its inferred `throws` set. Quick-fixes:
wrap in try/catch (pre-populated with `instanceof` arms per escaping type), add
a configured sink, add `@throws` tag, add overlay entry.

## Known unsoundness (accepted, documented)

Throwing getters/setters/Proxies/`valueOf`/`toString`; effects through `any`
under optimist dispatch; `trust`ed packages; generator `.throw()` injection;
dynamic `import()` of unanalyzed modules. Not modeled in v1.

## Milestones

- **M1 — Typed core, sync (requires kernel K1; lands together with it).**
  Escape-set lattice with widening; sources 1–4; sink subtraction rules exactly
  as above; `@throws` check; base overlay; diagnostics with chains.
  *Accept:* fixture matrix — direct throw, transitive, union throws, catch
  subtraction with instanceof + rethrow remainder, wrap-and-throw, conditional
  rethrow conservatism, throwing finally, subtype discharge, widening to TOP,
  `throwsFromCallbacks` through `Array#map`, self/mutual recursion, handler
  boundary, partial configured sink (`absorbs` subset), both dispatch modes,
  `@throws` under- and over-declaration.
- **M2 — Cache integration (requires K2).** Summaries serialize with stable
  type-ref encoding (symbol → declaration file + qualified name); verify
  invalidation when an error class's declaration moves or changes.
- **M3 — Untyped-boundary policy.** Three modes + overrides + user overlays.
  *Accept:* fixture with an untyped JS dep under all three modes.
- **M4 — Async.** Rejection sets on async summaries; `await` converts rejection
  to throw at the await site; floating promises escape where dropped;
  `.catch(handler)` subtraction (same rethrow rules); `try`-around-`await`;
  `Promise.all/allSettled/race/any` composition. *Accept:* async mirror of the
  M1 sink/rethrow matrix + floating-promise cases.
- **M5 — Editor polish (requires K3).** Hover sets, typed quick-fixes,
  provisional-mode messaging.

## First step

M1 + kernel K1 on the fixture tree, then run on a real non-Effect subtree
(e.g. `packages/shared`) and hand-review every diagnostic. The false-positive
census — not the feature list — decides everything downstream.
