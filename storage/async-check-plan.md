# analyze `async` channel — Structured Concurrency for Plain TS

A analyze channel (see `analyze-kernel-plan.md`). Requires kernel K1; benefits
from the `exceptions` channel's M4 rejection sets but does not require them.

**The port:** Effect fibers are structured — children are supervised, scoped to
their parent, and interruption propagates. Plain TS promises are unstructured:
they outlive their creator, swallow rejections when dropped, fan out unboundedly,
and ignore cancellation unless every layer hand-threads an `AbortSignal`. This
channel checks the three properties that make promise code Effect-shaped without
Effect.

**Division of labor:** *where a rejection escapes to* is the `exceptions` channel
(M4). This channel owns promise **lifecycle**: ownership of the promise value,
concurrency structure, and cancellation plumbing.

## Check 1 — Promise ownership (no orphan fibers)

Every created promise must be **owned**: awaited, returned, aggregated
(`Promise.all/allSettled/race/any`, `.then` chains — ownership moves to the
result), stored with a tracked consumer, or **explicitly voided** (`void expr`
statement — the annotation that says "fire-and-forget on purpose"). A promise
that is none of these is an orphan: its rejection is invisible and its work is
unsupervised.

This subsumes lint-level `no-floating-promises` but is call-graph aware: a
function returning `Promise<void>` whose callers all ignore the result is
flagged at the *callers*; a helper that internally spawns-and-forgets is flagged
even when every direct call site looks innocent. Tracking uses the same
local-accountability rule as the resources channel (a promise stored into an
opaque structure degrades by the dispatch knob, logged).

## Check 2 — Bounded fan-out

Flag unbounded dynamic concurrency: `Promise.all(items.map(async …))` (and
friends) where `items` has no statically known small bound — the plain-TS
equivalent of Effect's `{ concurrency: "unbounded" }`, which Effect makes you
*write*; here nothing does. Config:

```jsonc
"channels": { "async": {
  "fanOut": "warn",              // off | warn | error
  "fanOutAllowLiteralUpTo": 16,  // array literals / tuples this size are fine
  "poolFunctions": ["p-limit", "p-map", "myLib#mapBounded"]  // sanctioned wrappers
} }
```

Calls routed through a configured pool function are satisfied. This check is
per-call-site (no propagation), cheap, and independently valuable — likely the
best noise/value ratio in the whole channel; it lands first.

## Check 3 — Cancellation propagation

Overlay marks APIs as **cancellable** (accepting `AbortSignal`: `fetch`,
`setTimeout` via `signal`, node `fs`/`stream` options, …). Rule: a function that
*receives* a signal (param or destructured option, identified by type
`AbortSignal`) should forward it to every cancellable callee it awaits;
awaiting a cancellable callee *without* the signal you hold is a diagnostic
("`fetch` not passed the `signal` this handler received — uncancellable work").
Functions that hold no signal are not flagged (adopting cancellation is a
choice; dropping it mid-chain is a bug). Summary: "forwards signal to all
cancellable awaits: yes/no/n-a", propagated so wrappers inherit
cancellability requirements.

## Explicitly out of scope (v1)

Deadlock detection, fairness, `async_hooks` context loss, priority. Races on
shared state are the `context` channel's territory if anywhere.

## Diagnostics

Orphans: at the expression that drops the promise ("result of `syncUsers()` is
neither awaited nor voided — rejections will be unhandled"). Fan-out: at the
aggregation call. Cancellation: at the unforwarded await. Quick-fixes: add
`await`, prefix `void `, route through a configured pool, pass `{ signal }`.

## Milestones

- **A1 — Fan-out check.** Per-call-site, config + pool functions. *Accept:*
  fixtures for literal-bounded ok, dynamic flagged, pool-wrapped ok, each mode.
- **A2 — Ownership.** Local tracking + caller-side flagging via summaries,
  `void` annotation, degradation log. *Accept:* orphan in statement position,
  orphan via ignored return across module boundary, then-chain transfer,
  stored-promise degradation under both dispatch modes.
- **A3 — Cancellation.** Cancellable overlay for fetch/timers/node, signal
  possession detection, forwarding summaries. *Accept:* handler forwards /
  drops / never-had-signal fixtures; wrapper inheritance.
- **A4 — Editor (requires K3).** Quick-fixes above.

## First step

A1 alone on a real tree — it needs no propagation machinery beyond K1's walk,
so it can ship early while `exceptions` is still proving its noise floor, and it
gives fast evidence the multi-channel product shape works.
