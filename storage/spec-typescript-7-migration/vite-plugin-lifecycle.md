---
type: refactor
recommended-model: sonnet
status: PENDING
validation: deterministic
depends-on: [types-plugin-contract, coordinator-api-reparse, language-service-api-lifecycle]
files-own: [src/compiler/plugins/vite.ts, tests/compiler/plugins.test.ts]
tests: [tests/compiler/plugins.test.ts]
priority: P0
api-impact: none
---

# Vite Plugin: Snapshot Updates and Process Lifecycle

## Rationale

src/compiler/plugins/vite.ts breaks on two lines only — the `~/index` ts import (line 3) and the `ts.createSourceFile(..., ts.ScriptTarget.Latest, true)` fallback (line 51) — but inherits two contract changes from upstream items: `languageService.update` now returns `{ checker, program }` and `coordinator.transform` takes the project pair. It also inherits a NEW obligation: the language-service entry now owns a tsgo child process, so the plugin must dispose it when vite tears down — the TS5 LanguageService had no such requirement and today's plugin (correctly, then) never cleans up. Factory signature and runtime behavior are unchanged for consumers — api-impact: none.

## Design

Exact recipe:

**src/compiler/plugins/vite.ts:**
1. Drop line 3 (`import { ts } from '~/index';`); no unstable imports are needed — SourceFile flows through inference from languageService.
2. transform() (lines 40-76): `let { checker, program } = languageService.update(root || '', normalizedId, code);` then `let sourceFile = program.getSourceFile(normalizedId) ?? languageService.parse(normalizedId, code);` (the parse() fallback replaces line 51's createSourceFile — same role: never let a missing program file kill the transform). Call `coordinator.transform(plugins, code, sourceFile, { checker, program }, key, ctx)` per the migrated signature. Error-catch behavior (lines 77-80) unchanged.
3. watchChange() (lines 82-88) unchanged — `languageService.invalidate` keeps its signature.
4. Lifecycle (settled): add two hooks to the returned plugin object and the `VitePlugin` type — `closeBundle() { languageService.dispose(root || ''); }` (build mode teardown) and `closeWatcher() { languageService.dispose(root || ''); }` (dev server shutdown). dispose() is idempotent by the language-service contract, so double-fire is safe. Also delete the root's shared context in both (mirroring watchChange's `contexts.delete`).

**tests/compiler/plugins.test.ts:**
1. The `vi.mock('~/compiler/language-service')` factory returns the NEW contract: `update` → `{ checker: {}, program: { getSourceFile: () => file } }` where `file` comes from real `languageService`... — NO: a mocked module cannot call its own real self. Settled: mock update/parse with `parse` delegating to a hoisted real import is not possible under vi.mock; instead the mock's `update` returns `{ checker: {} as unknown as Checker, program: { getSourceFile: () => undefined } }` and `parse` is a `vi.fn()` returning a REAL SourceFile obtained via `await vi.importActual('~/compiler/language-service')` inside the factory — vitest supports async mock factories with importActual. Add `dispose: vi.fn()` and keep `invalidate: vi.fn()`.
2. Drop `import ts from 'typescript'` and the mock's `ts.createSourceFile` usage (lines 2, 13); coordinator mock updates its stub signature to the project pair.
3. The "falls back to createSourceFile when getSourceFile returns undefined" test becomes "falls back to languageService.parse when getSourceFile returns undefined" — asserting the `parse` mock was called; all other assertions stay semantically identical.
4. Add a lifecycle test: calling the returned plugin's `closeBundle`/`closeWatcher` invokes `languageService.dispose` with the root.

## Reads

- src/compiler/language-service.ts — update/parse/invalidate/dispose contract the plugin and mocks mirror
- src/compiler/coordinator.ts — migrated transform signature
- src/compiler/types.ts — Plugin/SharedContext types
- node_modules/typescript/dist/api/sync/api.d.ts — Checker/Program types for the mock casts

## Acceptance

- 0 regressions in tests/compiler/plugins.test.ts under typescript@7, run scoped; the fallback and lifecycle behaviors covered.

## Checks

- pnpm agent:test tests/compiler/plugins.test.ts

## Notes

plugins/tsc.ts and plugins/index.ts contain no ts API usage (verified) — untouched. Rollup/vite guarantee closeBundle on build and closeWatcher on dev shutdown; a hard process kill still reaps the tsgo child only via the language-service module's own guarantees — that residual risk belongs to language-service, not here.
