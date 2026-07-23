---
type: refactor
recommended-model: opus
status: PENDING
validation: deterministic
depends-on: [types-plugin-contract, imports-node-handles, language-service-api-lifecycle]
files-own: [src/compiler/coordinator.ts, tests/compiler/coordinator.test.ts, tests/compiler/coordinator.bench.ts]
tests: [tests/compiler/coordinator.test.ts]
priority: P0
api-impact: breaking
---

# Coordinator: API-Routed Re-Parse Pipeline

## Rationale

The coordinator re-parses after every text mutation to keep node positions accurate — five `ts.createSourceFile` call sites (lines 49, 244, 253, 266, 269) plus `currentProgram.getTypeChecker()` (line 229). typescript@7 has no in-process parser and no `Program.getTypeChecker` (the checker lives on Project), so this is a genuine re-architecture, not a swap: every position-refresh routes through the language-service module's API-backed `parse()`, and the checker arrives through a changed public signature. `coordinator` is re-exported by src/compiler/index.ts and its `transform` signature changes — breaking.

## Changes

Position-refresh parsing becomes IPC-backed via the language-service module; the transform entrypoint's program parameter widens to a checker+program pair (the TS7 currency — Project satisfies it structurally); the between-plugin program refresh keeps its language-service route with the new return shape. The characterization test file and bench file migrate their plumbing; assertions preserved except the one documented fileName-sensitive case.

## Design

**Settled decisions:**

1. Imports: `import type { SourceFile } from 'typescript/unstable/ast';` + `import { isImportDeclaration } from 'typescript/unstable/ast/is';` + `import type { Checker, Program } from 'typescript/unstable/sync';`; drop `import { ts } from '~/index'` (line 3). Type-only imports from './types' and './imports' unchanged.
2. **Signature (the breaking decision):** `transform(plugins: Plugin[], code: string, file: SourceFile, project: { checker: Checker; program: Program }, root: string, shared: SharedContext)`. Rationale: TS7 splits checker from program; a structural pair is satisfied by the API's `Project` class (cli), by language-service `update()`'s return (vite), and by lightweight test stubs. `ctx.checker` (line 229) becomes `project.checker`; `ctx.program` passes `project.program`. `CoordinatorResult` retypes `sourceFile: SourceFile`.
3. **Re-parse routing:** all five `ts.createSourceFile(fileName, code, languageVersion, true)` sites → `languageService.parse(fileName, code)` — these are pure position-refresh parses (no checker semantics needed): applyImports' between-package refresh (line 49), post-replacement (244), pre-imports (253), the getSourceFile fallback (266), and the last-plugin refresh (269). The `languageVersion` argument disappears (the Go parser owns dialect selection).
4. **Between-plugin program refresh** (lines 264-266): `languageService.update(root, fileName, currentCode)` now returns `{ checker, program }` — destructure it, keep `program.getSourceFile(fileName) ?? languageService.parse(fileName, currentCode)` as the fallback, and thread the refreshed `{ checker, program }` as the project pair for the next plugin's ctx.
5. `applyIntents`/`applyPrepend`/`hasPattern`/`modify`/`replaceReverse` logic byte-identical (node `.end`/`.getStart(file)` survive per the Node method surface); `applyPrepend`'s `isImportDeclaration(stmt)` drops its `ts.` prefix.

**Named discretion point — round-trip minimization:** each parse is now a cross-process IPC call (was free). The implementer MAY reduce re-parse count (e.g. skip the line-49 refresh when only one package remains, reuse a refresh across the 244/253 pair when no replacement landed) — criterion: every existing coordinator.test.ts assertion stays green and output text is byte-identical; no reduction that reorders or merges observable mutations. Batching across PLUGINS is out of scope (pipeline order is contract).

**Test migration** (tests/compiler/coordinator.test.ts, 855 lines — assertions are the pinned contract):
- DROP the `vi.mock('~/compiler/language-service')` block (lines 9-21): a mock cannot fabricate TS7 SourceFiles (no in-process parser). Use the REAL language-service module — it landed two items ago and is exactly what production runs.
- `parse()` helper → `languageService.parse(fileName, code)`; `makeProgram(file)` → `makeProject(file)` returning `{ checker: {} as unknown as Checker, program: { getSourceFile: () => file } as unknown as Program }`; plugin visitors' `ts.forEachChild(n, visit)` → `n.forEachChild(visit)`; guards from unstable/ast/is; `afterAll(() => languageService.dispose())`.
- The mockReturnValueOnce fallback test (lines 752-777) re-targets the real module via `vi.spyOn(languageService.default, 'update')` returning `{ checker, program: { getSourceFile: () => undefined } }` — preserving the characterized fallback behavior.
- **Documented deviation channel:** the `REPLACED_IN_test.ts` assertion (line 631) reads `sf.fileName`. If `languageService.parse` cannot preserve the caller's bare fileName on the returned SourceFile (scratch-project qualification), update THAT assertion to the new fileName form and record it as a Deviation in the changelog row — it is the only fileName-sensitive assertion in the file.

**Bench migration** (tests/compiler/coordinator.bench.ts): same plumbing swap (real language-service, parse helper, method-form visitors); bench bodies unchanged. It must EXECUTE under TS7 (`pnpm bench:run`); no numeric gate — the TS5 implementation cannot run under the installed typescript@7, so no baseline exists.

## Reads

- node_modules/typescript/dist/api/sync/api.d.ts — Project/Program/Checker shapes the project pair mirrors
- node_modules/typescript/dist/ast/ast.d.ts — Node.getStart/.end + SourceFile.statements the apply fns use
- node_modules/typescript/dist/ast/is.d.ts — isImportDeclaration
- src/compiler/language-service.ts — parse()/update() contracts this pipeline consumes
- src/compiler/types.ts — migrated TransformContext/ReplacementIntent the ctx construction must satisfy
- src/compiler/imports.ts — ModifyOptions + all() consumed by modify()
- src/cli/tsc.ts — downstream caller whose call site the new signature must accommodate (migrates next item)
- src/compiler/plugins/vite.ts — second downstream caller (migrates in vite-plugin-lifecycle)

## Acceptance

- 0 regressions in tests/compiler/coordinator.test.ts under typescript@7, run scoped (assertions unchanged except the documented fileName-sensitive case).

## Checks

- pnpm agent:test tests/compiler/coordinator.test.ts

## Verify

`pnpm bench:run` — tests/compiler/coordinator.bench.ts must execute to completion under typescript@7 (run in-seat; no numeric gate, no baseline exists).

## Directives

1. src/compiler/coordinator.ts — swap imports to typescript/unstable subpaths; change transform's fourth parameter to the `{ checker, program }` project pair and thread it through ctx; route all five ts.createSourceFile refresh sites through languageService.parse and adapt the between-plugin update() destructuring; drop the ts. guard prefix in applyPrepend.
2. tests/compiler/coordinator.test.ts — remove the language-service vi.mock in favor of the real module; migrate parse/makeProgram helpers and visitor plumbing to the TS7 forms; re-target the fallback test via vi.spyOn; add afterAll disposal; keep every assertion byte-identical except the documented fileName-sensitive case.
3. tests/compiler/coordinator.bench.ts — apply the identical plumbing migration to the bench harness; bench bodies unchanged.

## Notes

Plugins receive `ctx.program` for their own analysis (e.g. imports.includes takes the checker) — the pair keeps both flowing without a Project dependency in test contexts. cli and vite adapt their call sites in their own items; do not edit them here even though the signature they call changes (they are already red under TS7 — the build-green gate, not this item, proves the joint compile).
