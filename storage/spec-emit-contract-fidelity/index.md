# Emit Contract Fidelity Fix Spec

## Clarifying Questions

> Answer inline under each **A:**, then tell me you're done. Blocking questions gate the feature files
> they list; optional questions already have a sensible default applied — fill one in only to override.
> I'll apply your answers and move each answered question to the Answered log (I won't ask it again).

### Open — Blocking
- **Q1** · sourcemap fidelity scope · blocks: [sourcemap-composition]
  The plugin path currently emits `.js.map` files whose mappings were generated against the TRANSFORMED
  mirror text while `sources` points at the REAL source — every mapping past an injection point is off by
  the injected line count, and the Vite plugin returns `map: null` by construction. Fixing this is a NEW
  capability (the coordinator must produce an original→transformed mapping), not a bug fix. How far should
  this spec go?
  1. Full original→JS composition — per-edit line+column tracking through every replacement/prepend/import
     edit; likely requires a source-map library, which is itself an Ask-First dependency add.
  2. Line-shift composition — the coordinator records only line deltas (whole-line injections and
     replacement line-count changes) and the emitted map's line numbers are corrected; columns inside a
     replaced span map to the span start. Dependency-free and fixes the exact verified defect class. (Recommended)
  3. No composition — stop emitting a misleading map for transformed files and document the limitation;
     untransformed files keep their accurate maps.
  **A:**

- **Q2** · typescript version pinning · blocks: [pin-typescript-exact]
  This package's entire compiler surface imports `typescript/unstable/*`, an explicitly-unstable API, yet
  `package.json` carries `typescript: ^7.0.2` — any 7.x minor can break every import. Pinning is a
  dependency decision (Ask-First), so it is not applied by default.
  1. Pin exact `7.0.2`; bump deliberately with a verifying build. (Recommended)
  2. Keep the caret range and accept the breakage risk.
  **A:**

### Open — Optional
- **Q3** · `--watch` on the plugin path · affects: [argv-flag-gating] · assumed: gate with a clear error (exit 1)
  The plugin build path is one-shot; `--watch` is silently ignored today. Gate it with a clear error, or
  implement watch mode as a feature?
  **A:**

- **Q4** · e2e fixture access to the shipped tsconfigs · affects: [e2e-fixture-harness] · assumed: the
  harness copies `tsconfig.base.json` + `tsconfig.package.json` from the repo into each fixture temp dir at
  test runtime — hermetic AND in-sync by construction (copied from the live files on every run)
  A temp-dir fixture cannot resolve `@esportsplus/typescript/tsconfig.package.json` by package name.
  Alternative: point each fixture's `extends` at the repo's config by absolute path (simpler, couples the
  fixture to the repo layout).
  **A:**

- **Q5** · downstream smoke gate · affects: [emit-mirror-contract] · assumed: the in-repo e2e suite is the
  acceptance gate; no downstream install
  Should acceptance also install and build `d:/template` or `d:/ui` against the fixed package? Both
  currently lack `node_modules`, and a private-registry install needs the npm token copied first.
  **A:**

### Answered
- **Q0** · spec location — the spec lives in this repo's own `storage/`; already applied.
- **Q0b** · build-time compilation tests — REQUIRED, and must cover the shipped `tsconfig.package.json`
  shape: declaration/declarationDir, rootDir, include, alias resolution via tsc-alias, sourcemap fidelity,
  and argv flag gating; applied across the items below.

## Metadata
- **Generated**: 2026-07-25
- **Synthesizer**: claude-fable-5 · seat roles.synthesizer · router HARD
- **Research sources**: Mode 4 in-context evidence (RSC-v1 dispatch, empirically verified by the calling
  session against the live repo on 2026-07-25) + direct file reads S1–S12 (see the dispatch return's
  Sources registry)
- **Threshold**: n/a — no perf items (repo exposes `agent:test`/`agent:build` but no `agent:bench`)
- **Total features**: 5
- **Model mix**: opus 3 · sonnet 2

## Baseline
- **Commit**: d3bc45b (`main`)
- **Gates**: `vitest run` 139 passed / 9 files · `tsc --noEmit` exit 0 · `tsc && tsc-alias` exit 0
  (caller-verified 2026-07-25; every item must keep all three green)

## Features

- e2e-fixture-harness
- emit-mirror-contract
- argv-flag-gating
- sourcemap-composition
- pin-typescript-exact
- plugin-path-silent-failures
- escape-and-symbol-guards

## Feed
run,scope,unit,ordinal,slug,event,state,detail,elapsed_ms,ts
,item,mutator,,sourcemap-composition,requeued,REQUEUED,,,2026-07-25T02:37:02-07:00
,item,mutator,,pin-typescript-exact,requeued,REQUEUED,,,2026-07-25T02:37:02-07:00
