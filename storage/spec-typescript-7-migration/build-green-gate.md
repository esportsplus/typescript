---
type: chore
recommended-model: sonnet
status: PENDING
validation: deterministic
depends-on: [ast-unstable-guards, baseline-regression-gate, cli-tsgo-emit, coordinator-api-reparse, imports-node-handles, language-service-api-lifecycle, root-export-surface, types-plugin-contract, vite-plugin-lifecycle]
tests: [tests/cli/tsc.test.ts, tests/compiler/ast.test.ts, tests/compiler/code.test.ts, tests/compiler/coordinator.test.ts, tests/compiler/imports.test.ts, tests/compiler/language-service.test.ts, tests/compiler/plugins.test.ts, tests/compiler/uid.test.ts, tests/index.test.ts]
priority: P0
api-impact: none
files-own: [build]
---

# Build Green Gate

## Rationale

Per-item gates are scoped and vitest does not type-check, so cross-module type coherence has no proof until the whole graph lands. This terminal item is the spec's integration gate: full `pnpm build` (tsgo type-check + emit + tsc-alias `~` rewriting) at zero errors, plus the complete characterization suite green under typescript@7 — restoring the two facts that were true at the baseline commit under TS5 (measured broken state at authoring: ~80 build errors, 70/122 tests failing).

## Changes

The gitignored `build/` emit tree regenerates via `pnpm agent:build` — the only surface this item writes, and its declared ownership. Source, tests, and config are untouched: any red is a defect belonging to the item that owns the offending file and is reported against that item, never patched here (a gate that edits sources is a gate that hides).

## Design

1. `pnpm agent:build` (the baseline item's alias for `pnpm build` → `tsc && tsc-alias`, where `tsc` resolves to typescript@7's bin — the native tsgo). Must exit 0 with zero diagnostics; the emitted `build/` tree regenerating is a normal side effect.
2. `pnpm agent:test` — the full suite (all 9 test files, 122+ inherited assertions plus the coverage added by the migration items) green under the DEFAULT config: no legacy alias exists in the tree (baseline-regression-gate removed its scaffolding before completing).
3. On any failure: report the failing file/diagnostic verbatim and stop — the fix belongs to the owning item's surface. Zero write authority here.

## Reads

- package.json — build/test scripts + the expected absence of typescript-legacy residue
- tsconfig.json — the config `pnpm build` gates on (extends tsconfig.package.json → tsconfig.base.json)

## Acceptance

This item's own surface IS the build (the documented exception to scoped-evidence phrasing): `pnpm agent:build` exits 0 with no diagnostics, and `pnpm agent:test` exits 0 across all 9 test files.

## Checks

- pnpm agent:build
- pnpm agent:test

## Notes

`prepare`/`prepublishOnly` both run `pnpm build`, so this gate is also the publishability proof for @esportsplus/typescript@>=0.30.0. tsgo honoring the repo's `${configDir}` tsconfig templating is implicitly proven by check 1 — if it fails there, that finding routes to cli-tsgo-emit's overlay design as context, not to this item.
