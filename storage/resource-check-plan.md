# tscheck `resources` channel — Scope/acquireRelease for Plain TS

A tscheck channel (see `tscheck-kernel-plan.md`). Second channel to land (kernel
K4) — it hardens the plugin interface with a summary shape different from
`throws`.

**The port:** Effect's `Scope`/`acquireRelease` guarantees a resource acquired is
released exactly once, on every path, including failure paths. Plain TS has the
mechanics (`using`/`Symbol.dispose` since TS 5.2, try/finally, close methods) but
nothing checks you used them. This channel tracks acquisition **obligations**
through the call graph and reports resources that can leak.

## The obligation model

An **acquire site** creates an obligation; the obligation is met when, on every
path from the acquire (including throwing paths — consume the `throws` channel's
summaries to know which calls can throw), one of:

- **Discharge** — the paired release is called on the tracked value (`clearInterval`
  for `setInterval`, `removeEventListener` for `addEventListener`, `[Symbol.dispose]`,
  `.close()`, …), or the value is bound with `using`/`await using`, or released in
  a `finally` guarding the region.
- **Transfer** — ownership demonstrably leaves the function: the value is
  returned, passed to a parameter declared as **taking ownership** (overlay/
  config annotation), or stored on `this`/an object that outlives the call
  (transfer to the object; see limits).

A function's summary: obligations it **creates and leaks** (diagnostic material),
obligations it **discharges for its arguments** (so `withFile(path, cb)` patterns
summarize as "param 0's obligation handled here"), plus the kernel-standard
callback conditionality (a leak inside a callback passed to `map` belongs to the
callback's author).

What counts as a resource comes from **overlays/presets, plus anything typed
`Disposable`/`AsyncDisposable`**:

```jsonc
"resources": {
  "node:fs/promises": { "open": { "acquires": "FileHandle", "releasedBy": "#close" } },
  "lib.dom": {
    "setInterval":      { "acquires": "IntervalHandle", "releasedBy": "clearInterval" },
    "addEventListener": { "acquires": "Listener", "releasedBy": "removeEventListener",
                           "pairKey": [0, 1] }   // same target+type+fn discharges
  }
}
```

Base preset ships with: timers, event listeners, `fs` handles, net/http sockets
and servers, `AbortController` (informational), streams, worker threads,
`ResizeObserver`/`MutationObserver`, WebSocket, and `Disposable` itself.

## Tracking limits (locked, v1)

Alias analysis is the tar pit; v1 tracks obligations only while the value stays
**locally accountable**: a single binding (const/let with no reassignment after
acquire), possibly narrowed, passed directly to calls. The moment a tracked value
flows somewhere opaque — pushed into an array, captured by a closure that
escapes, assigned through `any` — the obligation degrades by the channel's
dispatch knob: optimist = assume transferred (silent), pessimist = report
"untrackable resource". Log every degradation; that log measures whether v1's
tracking is enough. Do NOT build a points-to analysis before that log says so.

`this`-stored resources create a **class-level obligation**: a class that stores
a resource in a field should itself be `Disposable` (or have a configured
release method) that discharges it; if it is, the instance becomes a resource of
that class type and tracking recurses at construction sites. If it isn't, one
diagnostic at the field, not one per instantiation.

## Diagnostics

At the **acquire site**: "`setInterval` handle can leak — no `clearInterval` on
the path where `parse()` throws (src/poll.ts:30)". The leaking path (including
the throwing call that bypasses the release) is the related-information chain.
Quick-fixes: wrap in try/finally, convert to `using` when the type is
disposable, add ownership-transfer annotation.

## Milestones

- **R1 — Sync obligations (requires K1; lands with K4).** Acquire/discharge/
  transfer on straight-line and branching sync code, `using` support, finally
  discharge, throws-channel integration for exceptional paths, base preset,
  local-accountability tracking + degradation log.
  *Accept:* fixtures — leak on early return, leak on throwing path, finally
  discharge, `using` discharge, transfer by return, transfer by ownership
  param, withResource callback pattern, listener pair-key matching, class field
  with and without disposal, degradation on push-to-array under both dispatch
  modes.
- **R2 — Async lifetimes.** `await using`; obligations across `await` points
  (a throw between acquire and release via rejected await is a leak path —
  reuse throws M4 rejection sets); resources acquired in async loops.
- **R3 — Editor (requires K3).** Hover "acquires/leaks", quick-fixes above.

## First step

R1 against fixtures, then run on a real tree with only the timers + listeners
preset enabled — those two alone catch the most common real leak class (interval
and listener leaks in long-lived servers/UIs) and give the cleanest first
noise-floor read.
