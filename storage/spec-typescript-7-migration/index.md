# TypeScript 7 Migration Spec

## Clarifying Questions

> Answer inline under each **A:**, then tell me you're done. Blocking questions gate the feature files
> they list; optional questions already have a sensible default applied — fill one in only to override.
> I'll apply your answers and move each answered question to the Answered log (I won't ask it again).

### Open — Optional
- **Q1** · live TS5 baseline capture · affects: [baseline-regression-gate] · assumed: proceed on the existing 1,814-LOC suite as the pinned contract — no new dependency
  The suite pre-exists, is git-tracked, and was authored green against TS5, so the regression gate is already in-tree; the default needs no approval. A LIVE TS5 verification would add recorded confidence (catching any silently-stale assertion before migration begins) but requires a temporary dev alias `typescript-legacy: npm:typescript@^5.9.3` (an Ask-First dependency add — answering YES here IS that approval), added and removed within the item with zero residue. Opt in?
  **A:**
- **Q3** · test tree layout · affects: [baseline-regression-gate] · assumed: keep the existing `tests/` layout
  Global convention places tests at `test/<mirror of source dir>`, but this repo's established suite lives at `tests/compiler/*` with `vitest.config.ts` including `tests/**/*.test.ts`. Relocating 9 files would churn the regression gate itself mid-migration. Keep `tests/` as-is?
  **A:**

### Answered
- **Q0a** · migration direction — FULL migration to `typescript/unstable/*` (settled interactively; no pin-back to 5.x, no two-phase pin-then-migrate).
- **Q0b** · test strategy — characterization/regression gate is the OPENING item, before any migration item (settled interactively).
- **Q2** · root public export shape — Option 1 (drop the `ts` re-export entirely; `src/index.ts` becomes `export {};` and consumers import `typescript/unstable/*` subpaths directly).

## Metadata
- **Generated**: 2026-07-22
- **Synthesizer**: claude-fable-5 · seat roles.synthesizer · router HARD
- **Research sources**: Mode 4 in-context findings (dispatch evidence: verified TS7 export map + dist/*.d.ts API surface + per-call-site removal map) corrected and extended by direct repo verification this session (S1–S15 in the delivery report)
- **Evidence correction**: the dispatch evidence claimed "ZERO tests exist" — refuted by direct read: `tests/` holds 8 test files + 1 bench file (1,814 LOC); measured under typescript@7.0.2: 52 pass / 70 fail of 122 (5 of 8 files failing). Item 1 is therefore a baseline-verification + gate-wiring item, not a from-scratch authoring item. Also verified: all five ts-consuming modules import `ts` via the `~/index` re-export hub, making `src/index.ts` an internal dependency, not just public surface.
- **Threshold**: n/a (no perf items)
- **Total features**: 10
- **Model mix**: opus 4 · sonnet 6
- **Spec UUID**: b92bb771-ecf7-40ea-b47b-c533d0f0b867

## Baseline
- **Commit**: 8db4e65abe603e2ce32bcab60152619091f9e7ef (branch main; only package.json + pnpm-lock.yaml modified — the typescript@7.0.2 bump)
- **Benchmark**:
  | Metric | Value | Unit |
  |--------|-------|------|
  | vitest suite under typescript@7.0.2 (`pnpm test`, pre-migration) | 52 pass / 70 fail of 122 | tests |
  | test files failing (ast, coordinator, imports, plugins, language-service) | 5 of 8 | files |
  | `pnpm build` (tsc && tsc-alias) | fails — ~80 errors, all one root cause (root-entry API removal) | errors |

## Public API Changes

- [types-plugin-contract.md](./types-plugin-contract.md) — Plugin-facing type contract moves to typescript/unstable types
- [ast-unstable-guards.md](./ast-unstable-guards.md) — ast helpers retyped over typescript/unstable/ast nodes
- [imports-node-handles.md](./imports-node-handles.md) — imports.includes retyped over Checker and NodeHandle declarations
- [coordinator-api-reparse.md](./coordinator-api-reparse.md) — coordinator.transform program parameter becomes { checker, program }
- [root-export-surface.md](./root-export-surface.md) — root `ts` re-export dropped; consumers import typescript/unstable/* directly

## Features

- baseline-regression-gate
- types-plugin-contract
- language-service-api-lifecycle
- ast-unstable-guards
- imports-node-handles
- coordinator-api-reparse
- cli-tsgo-emit
- vite-plugin-lifecycle
- root-export-surface
- build-green-gate

## Feed
run,scope,unit,ordinal,slug,event,state,detail,elapsed_ms,ts
,item,mutator,,baseline-regression-gate,requeued,REQUEUED,,,2026-07-22T04:28:53-07:00
,item,mutator,,language-service-api-lifecycle,requeued,REQUEUED,,,2026-07-22T04:46:45-07:00
,item,mutator,,root-export-surface,requeued,REQUEUED,,,2026-07-23T00:30:51-07:00
