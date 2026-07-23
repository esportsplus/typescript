---
type: refactor
recommended-model: opus
status: PENDING
validation: deterministic
depends-on: [types-plugin-contract, coordinator-api-reparse, language-service-api-lifecycle]
files-own: [src/cli/tsc.ts, src/cli/diagnostics.ts, tests/cli/tsc.test.ts]
tests: [tests/cli/tsc.test.ts]
priority: P0
api-impact: none
---

# CLI: Config, Diagnostics, and tsgo Emit

## Rationale

src/cli/tsc.ts is the published `tsc`/`esportsplus-tsc` bin. Every leg is broken under typescript@7: config discovery/parse (`ts.findConfigFile`/`readConfigFile`/`parseJsonConfigFileContent` — lines 26, 170, 176), program+diagnostics (`ts.createProgram`/`getPreEmitDiagnostics`/`flattenDiagnosticMessageText`/`formatDiagnosticsWithColorAndContext` — lines 31, 40, 90, 95, 99), the transformed-source injection host (`ts.createCompilerHost` — line 67), EMIT (`program.emit()` — line 93; the unstable API's Emitter does `printNode` ONLY, no emit-to-disk exists anywhere in typescript@7), and even the no-plugin passthrough (line 205's `require.resolve('typescript/lib/tsc.js')` throws ERR_PACKAGE_PATH_NOT_EXPORTED under the TS7 exports map). Emit must shell out to the bundled tsgo binary; `lib/tsc.js` is a verified self-contained ESM shim that exec's it with inherited stdio and propagated exit status.

## Changes

Config discovery moves to a node:fs walk + API-routed parse; pre-emit diagnostics aggregate from the Program's split diagnostic families; message flattening and colored context formatting are hand-rolled in a new diagnostics module over the FLAT TS7 Diagnostic shape; emit becomes a spawned tsgo child compiling the project with transformed sources overlaid; passthrough re-anchors its resolve path; the tsc-alias chain and exit-code semantics are preserved. Test file migrates and gains the missing end-to-end emit characterization.

## Design



**Settled decisions:**

1. **Resolve anchor** (fixes passthrough AND locates tsgo): `tsDir = path.dirname(require.resolve('typescript/package.json'))` — `./package.json` IS in the exports map; direct file paths bypass it thereafter. Passthrough (line 205) and the emit spawn both become `spawn(process.execPath, [path.join(tsDir, 'lib', 'tsc.js'), ...args], { stdio: 'inherit' })` — lib/tsc.js execs the native binary via its internal `#getExePath` and forwards the exit status (verified by reading the shim). Exit-code propagation and the `runTscAlias`-on-success chain (lines 111, 206-211, 215-227) keep their exact current shape.
2. **main()** (lines 169-196): `ts.findConfigFile` → `languageService.findConfig(process.cwd())`; the plugin sniff reads the tsconfig text via node:fs. Named discretion: JSONC handling for the sniff (tsconfigs legally carry comments/trailing commas) — implementer picks the mechanism (minimal tolerant scan is acceptable); criterion: a commented tsconfig with a `plugins` array sniffs correctly, pinned by a fixture case in the test file. No plugins → passthrough, unchanged decision flow.
3. **build()** (lines 24-112):
   - Config parse: `api.parseConfigFile` via the language-service entry for `root` — yields ONLY fileNames + options (ConfigResponse carries NO diagnostics member — dist/api/proto.d.ts:47-50); config diagnostics arrive via `project.program.getConfigFileParsingDiagnostics()`, exactly the family the type gate below already concatenates first — the error path prints those flattened and keeps `process.exit(1)` (replaces parseJsonConfigFileContent).
   - Transform pass: iterate fileNames; `sourceFile` from the project's `program.getSourceFile(fileName)`; `coordinator.transform(plugins, sourceFile.getFullText(), sourceFile, { checker: project.checker, program: project.program }, root, shared)` per the migrated signature; collect `transformedFiles` exactly as today.
   - Transformed-program refresh (replaces the custom compiler host, lines 66-91): push each transformed file through `languageService.update(root, fileName, code)` — the overlay IS the host replacement; the final `{ program }` reflects all transformed content.
   - Type gate (replaces getPreEmitDiagnostics, line 95): concatenate `program.getConfigFileParsingDiagnostics() + getSyntacticDiagnostics() + getBindDiagnostics() + getSemanticDiagnostics() + getGlobalDiagnostics() + getProgramDiagnostics()`; print via the new formatter; any error-category diagnostic → `process.exit(1)` (mirrors today's emitSkipped gate).
4. **src/cli/diagnostics.ts** (new module): `flatten(diagnostic: Diagnostic, indent?): string` — recursive walk over `messageChain` (TS7 Diagnostic is FLAT: `{ fileName?, pos, end, code, category, text, messageChain?, relatedInformation? }` — dist/api/sync/types.d.ts:288-309); `format(diagnostics: readonly Diagnostic[], root: string): string` — per diagnostic: read the file text (node:fs), `computeLineStarts(text)` from `typescript/unstable/ast/scanner` for pos→line:character, emit the `file:line:col - category TS<code>: text` header plus the source line with a caret underline, ANSI-colored by category (module-level color-code constants). All parameters explicitly typed — the old callback's implicit-any (line 100) must not reappear. Exported per repo layout (const arrows at bottom).
5. **EMIT — the settled contract, with a named mechanism:** observable contract is FIXED: (a) emitted JavaScript and declaration artifacts land at the real outDir with the same layout TS5 emit produced; (b) user sources are bytewise untouched after exit on EVERY path (success, diagnostic failure, thrown error, signal); (c) exit code is tsgo's when tsgo fails; (d) `runTscAlias` runs after successful emit exactly as today. Mechanism is a NAMED discretion point with two admissible realizations and a decision criterion:
   - RECOMMENDED — overlay mirror: materialize the project's fileNames under `<root>/node_modules/.cache/esportsplus-typescript/tsc-<pid>/` preserving relative layout (transformed content where present, disk content otherwise); write a generated tsconfig `{ extends: <absolute original tsconfig>, compilerOptions: { rootDir: <overlay root>, outDir: <absolute real outDir> (+ declarationDir when set) }, files: [<mirrored files>] }`; spawn tsgo `-p` on it; cleanup the overlay in `finally`. The cache-dir location keeps node_modules ancestry so dependency type resolution works; os.tmpdir() would break it.
   - FALLBACK — in-place with restore: back up only the transformed originals, write transformed text in place, spawn tsgo on the real tsconfig, restore in `finally` plus SIGINT/SIGTERM handlers.
   - Criterion: if the overlay's extends/rootDir mapping cannot reproduce the identical outDir layout and declaration paths in the fixture e2e test, switch to in-place. Either way the fixture test pins the contract, and `transformedFiles.size === 0` short-circuits to a direct tsgo spawn on the real tsconfig (no overlay at all).
6. Drop `import ts from 'typescript'` (line 9); type imports from './diagnostics', `typescript/unstable/sync`, and the migrated `~/compiler/types`. `languageService.dispose(root)` before each process.exit path in build() (the API child must not outlive the CLI).

**Test migration + new coverage** (tests/cli/tsc.test.ts): existing isPlugin/normalizePath/loadPlugins/runTscAlias suites are ts-free — preserved byte-identical. ADD (this is the emit characterization the suite has always lacked): an end-to-end fixture — mkdtemp project (the file's existing mkdtemp pattern, lines 50-60) with a tsconfig (including a comments+trailing-comma variant for the sniff pin), one source file, and a trivial local plugin that rewrites a marker identifier; invoke `build()`; assert the emitted .js exists in outDir, contains the transformed marker, sources are untouched, and a type-error fixture yields a nonzero exit/thrown gate. Plus a `flatten`/`format` unit block over hand-built flat Diagnostics (messageChain nesting, caret placement via computeLineStarts).

## Reads

- node_modules/typescript/package.json — exports map (why lib paths need the package.json anchor) + bin
- node_modules/typescript/lib/tsc.js — the spawn target shim (exec + exit-status forwarding, verified)
- node_modules/typescript/dist/api/proto.d.ts — ConfigResponse shape ({ options, fileNames } — no diagnostics member)
- node_modules/typescript/dist/api/sync/api.d.ts — Project.program diagnostic families + parseConfigFile
- node_modules/typescript/dist/api/sync/types.d.ts — the FLAT Diagnostic shape the formatter consumes
- node_modules/typescript/dist/ast/scanner.d.ts — computeLineStarts for pos→line:character
- src/compiler/language-service.ts — findConfig/update/dispose the CLI routes through
- src/compiler/coordinator.ts — migrated transform signature the build loop calls
- src/compiler/types.ts — Plugin/SharedContext types
- bin/tsc — the bin shim importing build/cli/tsc.js (must keep working unchanged)

## Acceptance

- 0 regressions in the preserved tests/cli/tsc.test.ts suites, run scoped.
- The new e2e fixture passes: transformed emit lands in outDir, sources untouched, error fixture gates nonzero, JSONC sniff fixture detected.

## Checks

- pnpm agent:test tests/cli/tsc.test.ts

## Directives

1. src/cli/diagnostics.ts — create the flatten + format module over the flat TS7 Diagnostic shape with computeLineStarts-based positions, ANSI category colors, fully typed parameters.
2. src/cli/tsc.ts — main()/passthrough(): tsconfig discovery via languageService.findConfig, JSONC-tolerant plugin sniff, package.json-anchored lib/tsc.js spawn path; preserve the passthrough/tsc-alias/exit-code flow.
3. src/cli/tsc.ts — build(): API-routed config parse, coordinator project-pair call sites, languageService.update overlay replacing the custom host, aggregated diagnostics through src/cli/diagnostics.ts, tsgo child-process emit honoring the settled contract, disposal before every exit.
4. tests/cli/tsc.test.ts — preserve existing suites; add the e2e emit fixture, the type-error gate fixture, the JSONC sniff fixture, and the diagnostics unit block.

## Notes

- The e2e fixture needs no fixture-local node_modules: a dependency-free source file type-checks against tsgo's bundled lib, and the plugin loads from a local path via loadPlugins' existing relative-path branch.
- `process.env.VITEST` guard on main() (line 230) stays — the test file imports the module.
- bin/tsc and bin/tsc-alias contain no ts API usage (verified) — out of scope.
