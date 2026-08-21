# tscheck — Analysis Kernel Plan

**The thesis:** Effect gives you typed errors, resource safety, structured
concurrency, and explicit context — but only for code wrapped in Effect. tscheck
brings those guarantees to **plain TypeScript** as static analysis over the stock
TS compiler API, usable across every TS project with zero runtime footprint and
zero code changes. You don't wrap your program in Effect; you point tscheck at it.

tscheck is **one tool, many channels**. Each Effect capability ports as an
*analysis channel* over a shared kernel:

| Effect concept            | tscheck channel  | Plan |
| ------------------------- | ---------------- | ---- |
| Typed error channel `E`   | `throws`         | `throw-check-plan.md` |
| `Scope` / `acquireRelease`| `resources`      | `resource-check-plan.md` |
| Structured concurrency    | `async`          | `async-check-plan.md` |
| Context / requirements `R`| `context`        | `context-check-plan.md` |

Channels share one kernel because they share one shape: **per-function summaries
propagated over the reachable call graph to a fixpoint**. Building that machinery
once — graph, cache, config, overlays, CLI, editor plugin — is the whole point.
A channel is a plugin measured in hundreds of lines, not a new tool.

All channels are heuristic bug-finders, not soundness proofs. Messaging never says
"cannot happen" — only "not found."

## Kernel responsibilities

The kernel owns everything channel-independent:

1. **Program host.** `ts.createProgram` + `TypeChecker` from the host project's
   tsconfig. `typescript` is a **peer dependency** (`>=5.5`) — analysis runs on
   the host's TS version. Detect non-strict configs and emit a one-time notice
   that the guarantee floor is "whatever your tsconfig proves."
2. **Call graph.** Demand-driven reachability from entry points; callee resolution
   via `TypeChecker` (declaration identity, never name strings); function-value
   flow tracking sufficient for one level of callback-position summaries (see
   Summary algebra). Only reached functions are analyzed — "modules in use", not
   all of node_modules.
3. **Fixpoint engine.** Tarjan SCC condensation; per-SCC fixpoint iteration over
   each channel's summary lattice. Channels supply `bottom`, `join`, `widen`, and
   a transfer function; the kernel guarantees termination by requiring a finite
   lattice height or a widening operator (channels with growing sets must cap and
   widen to their top).
4. **Summary cache.** Content-addressed, per-channel. App functions key on
   `(tsVersion, kernelVersion, channelVersion, path, bodyHash, sccHash,
   calleeSummaryHashes, typeEnvHash)` — `sccHash` covers the whole SCC (members
   are interdependent; never cache one individually), `typeEnvHash` digests the
   declaration files narrowing depends on. Dep functions key on
   `(tsVersion, channelVersion, pkg@version, symbol)`. Disk store +
   reverse-dependency map for invalidation. Editor warms it, build completes it.
5. **Config + presets + overlays.** One `tscheck.config.jsonc` at project root:

   ```jsonc
   {
     "entryPoints": ["src/main.ts"],       // globs; exports + bin auto-added
     "handlerBoundaries": [                 // callbacks analyzed as entry points
       { "callee": "express.Router#get", "callbackArgs": [1] }
     ],
     "presets": ["node", "express"],        // shipped data files, by name
     "overlays": ["./tscheck.overlay.jsonc"],
     "channels": {
       "throws":    { /* channel config, see its plan */ },
       "resources": { "enabled": false },
       "async":     { "enabled": false },
       "context":   { "enabled": false }
     }
   }
   ```

   Entry points and handler boundaries are **kernel** concepts shared by all
   channels — every channel's "escape" question is asked per handler, because
   real apps have top-level catch-alls/supervisors that would otherwise silence
   everything. Overlays (facts about bodyless declarations — lib.d.ts,
   `@types/*`) are one file format with per-channel sections; presets are
   built-in overlay+boundary bundles for common frameworks. The Effect preset is
   just a preset — no core special-casing.
6. **Diagnostics.** Channels emit `(site, message, escapeChain)`; the kernel
   formats, dedupes, maps to CLI output (nonzero exit) and LS diagnostics with
   related-information locations for the chain.
7. **Frontends.** One CLI (`tscheck`, per-channel enable/only flags), one
   language-service plugin loading under classic `tsserver` via
   `tsconfig.plugins[]`. The LS plugin runs two modes: **full** on warm cache
   (exact, with chains), **local** on cold cache (intra-file provisional
   diagnostics, flagged as such) while a background walk warms and upgrades.
   `tsgo` is not a stable programmatic host; CLI runs stock `typescript`.

## Summary algebra (kernel contract)

Every channel summary is **conditional on callback parameters**: a plain lattice
value plus optional per-callback-position dependence ("my effect includes whatever
the function passed at param 2 does"). This is locked kernel-wide because
higher-order code is where every channel's real findings live — `map`, handlers,
middleware — and a non-conditional summary forces always-noise or always-miss.
One level of conditionality in v1; deeper nesting collapses per the channel's
pessimist/optimist knob, logged so we can measure demand for more.

Unresolvable callees (through `any`, untracked function values, abstract methods)
degrade by a per-channel `dispatch: "optimist" | "pessimist"` knob, default
optimist (low noise).

Unmodeled bodyless leaves default to the channel's **no-effect** value plus a
deduplicated log sorted by reach count — that log is the worklist for growing the
base overlay. The strict alternative marks everything effectful and destroys the
noise floor before it can be measured. Locked.

## Package placement

Incubates as `packages/tscheck` in this monorepo; extraction to its own repo must
be a directory move. **Zero `@t3tools/*` or repo-local imports anywhere in
`src/`** — repo conventions live only in scaffolding (catalog, tsconfig extends,
`vp test run`/vitest). Copy, never import, any wanted utility pattern.

```
packages/tscheck/
  package.json               # private, type: module, subpath exports, no barrel
  tsconfig.json
  tscheck.config.jsonc       # self-hosting, eventually
  src/
    kernel/                  # program host, graph, fixpoint, cache, config
    channels/
      throws/
      resources/
      async/
      context/
    overlay/                 # base overlays + presets (data files)
    cli/
    plugin/                  # LS plugin
    fixtures/                # per-channel fixture trees pinning noise floors
```

## Milestones

Kernel milestones are K-numbered; each channel plan owns its own milestones and
states which K it requires. Every milestone is independently landable, opt-in,
and scoped for one agent to implement from the plan documents alone.

- **K0 — Scaffold.** Package, peer-dep wiring, vitest, fixture harness, config
  loader with schema validation and clear errors, empty CLI that builds a
  Program and lists reached functions from configured entry points.
- **K1 — Kernel core.** Call graph, callback-flow tracking, SCC + fixpoint with
  the channel plugin interface, handler-boundary expansion, diagnostics
  pipeline, dispatch knob plumbing, overlay/preset loading. Proven by the
  `throws` channel M1 (the first and driving consumer) — kernel and first
  channel land together; the plugin interface is extracted, not speculated.
- **K2 — Cache.** As specced above. *Accept:* warm re-run does zero re-analysis;
  touching a leaf `.d.ts` invalidates exactly the dependent cone.
- **K3 — LS plugin host.** Full/local dual mode, background warming, per-channel
  quick-fix registration.
- **K4 — Multi-channel hardening.** Second channel (`resources`) lands; anything
  throws-specific that leaked into the kernel gets pushed back out. Single
  program walk feeds all enabled channels in one pass.
- **K5 — Parallel fan-out (speculative — measure first).** A `Program` cannot
  cross `worker_threads`; each worker pays full program construction, so fan-out
  only wins when per-SCC analysis dominates setup. Build only if K2-cached
  serial runs are too slow on a large real tree.
- **K6 — Ship.** Docs (config reference, overlay/preset authoring, per-channel
  soundness caveats), opt-in `vp` gate here, publish-readiness pass confirming
  zero repo-local imports. Not in any repo-wide gate until noise floors are
  proven on real code.

## Locked decisions

- One tool, channel plugins, shared kernel — never N parallel tools.
- Conditional summaries and optimist-default dispatch are kernel-wide contracts.
- Unmodeled typed leaves default to no-effect + log, per channel.
- `typescript` as peer dep; TS version in every cache key.
- Entry points / handler boundaries are kernel config; sinks/discharges are
  channel config.
- Diagnostics attach where the user can act (channel picks the site) and carry
  the escape chain.
- Effect (the library) is a preset, never a special case. tscheck complements
  Effect codebases (their typed channels already cover wrapped code) and
  substitutes for the unwrapped rest.

## First step

K0 + K1 driven by `throws` M1 (see `throw-check-plan.md`), then run on a real
non-Effect subtree and hand-review every diagnostic. The false-positive census
decides everything downstream.
