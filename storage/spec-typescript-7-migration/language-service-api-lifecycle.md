---
type: refactor
recommended-model: opus
status: PENDING
validation: deterministic
depends-on: baseline-regression-gate
files-own: [src/compiler/language-service.ts, tests/compiler/language-service.test.ts]
tests: [tests/compiler/language-service.test.ts]
priority: P0
api-impact: none
---

# Language Service: API/Snapshot Lifecycle Module

## Rationale

The entire 121-line module is built on removed API (`ts.createLanguageService`, `ts.LanguageServiceHost`, `ts.ScriptSnapshot.fromString`, `ts.getDefaultLibFilePath`, `ts.findConfigFile`, `ts.readConfigFile`, `ts.parseJsonConfigFileContent`, `ts.sys.*`). More importantly, typescript@7 has NO in-process parser anywhere (verified: full grep of dist/ — `createSourceFile` in factory.generated.d.ts:518 assembles a SourceFile from already-parsed statements; parsing happens only inside the Go server process). This rewrite therefore becomes the SINGLE owner of the API/child-process lifecycle for the whole package: every later item (ast/imports/coordinator tests, coordinator re-parse, cli config+program, vite) gets its TS7 SourceFiles through this module. It is internal-only (not re-exported by src/compiler/index.ts) — api-impact: none despite a changed internal contract.

## Changes

Module rewrite: the per-root cache of {host, service, versions} becomes a per-root cache of {api, snapshot, project, contents}; incremental update maps onto snapshot fileChanges; two NEW capabilities are added — a standalone text→SourceFile parse (the package-wide replacement for `ts.createSourceFile`) and explicit disposal (the API spawns a tsgo child process; TS5 had no such resource). Its test file is rewritten in the same item to pin the new contract while preserving every existing behavioral assertion's semantics.

## Design

**New module contract** (default export, mirroring the current object shape; all internal fns use `function`, exported const at bottom, per repo standards):

- `findConfig(startDir: string): string | null` — nearest tsconfig.json walking UP via node:fs (`existsSync` per ancestor dir); replaces `ts.findConfigFile` here and is consumed by cli-tsgo-emit.
- `update(root: string, fileName: string, content: string): { checker: Checker; program: Program }` — sets the in-memory overlay content for fileName, advances the snapshot with `api.updateSnapshot({ fileChanges: { changed: [id] } })` (`created` on first sight), refreshes the cached project reference from the NEW snapshot, disposes the superseded Snapshot (Snapshot.dispose() exists — dist/api/sync/api.d.ts), and returns the project's checker + program. Contract preserved from today: `program.getSourceFile(fileName)` on the return reflects EXACTLY `content` (the current tests at tests/compiler/language-service.test.ts:18-51 pin this).
- `parse(fileName: string, content: string): SourceFile` — standalone position-accurate parse of arbitrary text: a module-level lazy scratch API instance whose `fs` overlay (APIOptions.fs — dist/api/fs.d.ts: `readFile` returning string=content / null=absent / undefined=fall-through-to-real-fs) holds a minimal scratch tsconfig + the file; per call: set content, `updateSnapshot({ fileChanges })`, return `project.program.getSourceFile(id)` (non-null asserted with a module-prefixed throw per the error standard). This is the package-wide `ts.createSourceFile` replacement.
- `invalidate(root: string, fileName: string): void` — preserved semantics: drops overlay content so the next update/read falls through to disk; bookkeeping marks the file changed for the next snapshot advance.
- `dispose(root?: string): void` — for one root (or all when omitted): calls `snapshot.dispose()` on the entry's Snapshot, then `api.close()` on its API — the API class exposes `close()`, NOT `dispose()` and no `[Symbol.dispose]` (dist/api/sync/api.d.ts:40) — and evicts the cache entry; idempotent (guard on `snapshot.isDisposed()`). The all-roots form also closes the scratch parse API. Every cache-evicting path MUST close its API — the child process (tsgo) leaks otherwise.

**Entry creation** (`create(root)`): `findConfig(root)` (throw `@esportsplus/typescript: tsconfig.json not found` — preserve today's message shape, language-service.ts:23), then `new API({ cwd: root, fs: overlay })` where overlay's readFile/fileExists consult the entry's `contents` map first and return `undefined` to fall through to the real fs; `updateSnapshot({ openProjects: [configFileName] })`; project via `snapshot.getProject(configFileName)` with `getDefaultProjectForFile` as the documented fallback. Config-parse errors: `api.parseConfigFile(configFileName)` returns ONLY `{ options, fileNames }` (ConfigResponse, dist/api/proto.d.ts:47-50 — it has NO diagnostics member), so error surfacing routes through `project.program.getConfigFileParsingDiagnostics()` (dist/api/sync/api.d.ts:205) immediately after the snapshot opens: any error-category diagnostic → the same module-prefixed throw pattern as today (lines 28-40), carrying the first diagnostic's `text`.

**Named discretion points** (evidence does not settle these; implementer decides, criterion fixed):
1. DocumentIdentifier form (bare path vs `fileNameToDocumentURI`) — criterion: `program.getSourceFile(<the same fileName the caller passed>)` must round-trip on Windows paths; the `documentURIToFileName`/`fileNameToDocumentURI` helpers re-exported from unstable/sync are available if bare paths fail.
2. Virtual-file project membership — today's tests place virtual files at `<root>/test-virtual-*.ts`, OUTSIDE the repo tsconfig's `src/**` include. If the Go project refuses out-of-include files, relocate the virtual paths into `src/`-prefixed virtual space (the overlay makes them exist; `getAccessibleEntries` may need to report them) — criterion: the observable contract holds (update reflects content; invalidate falls back to disk); the test file may adjust virtual PATHS but not assertion semantics.
3. Pending-change bookkeeping shape (dirty-set vs per-call fileChanges) — criterion: no stale content is ever served after invalidate; each update() costs exactly one updateSnapshot round-trip.

**Test rewrite sketch** (tests/compiler/language-service.test.ts): preserve all 9 existing behavioral assertions under the new return shape (`update(...)` now destructures `{ program }`); add coverage for `parse()` (returns a SourceFile with `kind === SyntaxKind.SourceFile`, `text` round-trips, `statements.length` correct, positions usable via `getStart`), `findConfig()` (finds the repo tsconfig from a nested dir; null from a rootless temp dir), and `dispose()` (idempotent; update after dispose recreates the entry); `afterAll(() => languageService.dispose())` so vitest forks never leak tsgo processes.

**Perf note**: each update/parse is now a cross-process IPC round-trip (was in-process). No bench gate — the TS5 implementation cannot execute under the installed typescript@7, so no baseline is measurable; this is not a `type: perf` item.

## Reads

- node_modules/typescript/dist/api/sync/api.d.ts — API/Snapshot/Project/Program/Checker classes, updateSnapshot + parseConfigFile + dispose signatures
- node_modules/typescript/dist/api/options.d.ts — APIOptions (cwd, tsserverPath default, fs hook)
- node_modules/typescript/dist/api/fs.d.ts — FileSystem callback semantics (string/null/undefined tri-state) + createVirtualFileSystem
- node_modules/typescript/dist/api/proto.d.ts — UpdateSnapshotParams / FileChanges shapes
- node_modules/typescript/dist/ast/ast.d.ts — SourceFile members the tests assert against
- src/constants.ts — PACKAGE_NAME for error prefixes
- src/compiler/coordinator.ts — downstream consumer of update(); its call shape (line 264) must remain satisfiable
- vitest.config.ts — fork/pool behavior context for the afterAll disposal requirement

## Acceptance

- Rewritten module passes its rewritten characterization suite: update/invalidate semantics preserved, parse + findConfig + dispose covered, 0 regressions in tests/compiler/language-service.test.ts, run scoped.

## Checks

- pnpm agent:test tests/compiler/language-service.test.ts

## Notes

- The old contract returned a bare `ts.Program` with `getTypeChecker()`; TS7's Program has NO getTypeChecker (the checker lives on Project) — that is WHY the return shape becomes `{ checker, program }`. coordinator-api-reparse consumes this shape; do not add a compatibility shim.
- vitest transpiles without type-checking, so this item's gate is behavioral; whole-repo type errors are caught by build-green-gate.
- `resolveExePath`/tsserverPath default to the bundled tsgo binary (dist/api/options.d.ts) — never hardcode a binary path here.
