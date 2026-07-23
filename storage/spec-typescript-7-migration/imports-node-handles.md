---
type: refactor
recommended-model: opus
status: PENDING
validation: deterministic
depends-on: language-service-api-lifecycle
files-own: [src/compiler/imports.ts, tests/compiler/imports.test.ts]
tests: [tests/compiler/imports.test.ts]
priority: P0
api-impact: breaking
---

# Imports Analysis onto Checker + NodeHandle

## Rationale

src/compiler/imports.ts is the one module with a genuine SEMANTIC change, not just an import swap: in typescript@7, `Symbol.declarations` is `readonly NodeHandle[]` — handles carrying `{ index, kind, path }` plus a `resolve(project?)` materializer — not Node objects, and `symbol.getDeclarations()` no longer exists (dist/api/sync/api.d.ts Symbol class). The three `decl.getSourceFile().fileName` call sites (lines 119, 144, 159) and the `isImportSpecifier(decl)` structural walk (lines 109-117) must be redesigned around handles. Public surface: `imports` is re-exported by src/compiler/index.ts and `includes(checker: ts.TypeChecker, ...)` retypes onto the API's `Checker` — breaking for typed consumers.

## Changes

Guard/type imports move to unstable subpaths; symbol-declaration traversal moves from Node objects to NodeHandles, preferring the handle's own `.path` (no IPC round-trip) and resolving to a Node only where the parent-chain walk genuinely needs one. Test plumbing migrates to the TS7 parse helper; assertion semantics preserved.

## Design

**Settled decisions:**

1. Imports: drop line 1 (`import { ts } from '~/index'`); add `import type { Identifier, Node, SourceFile } from 'typescript/unstable/ast';` + `import type { Checker } from 'typescript/unstable/sync';` + guards `import { isIdentifier, isImportDeclaration, isImportSpecifier, isNamedImports, isStringLiteral } from 'typescript/unstable/ast/is';`. `cache` stays `WeakMap<SourceFile, Map<string, Set<string>>>` (line 17). `includes` signature: `(checker: Checker, node: Node, pkg: string, symbolName?: string)`.
2. `all(file, pkg)` (lines 29-62): guard prefixes drop, logic byte-identical — statements/importClause/namedBindings/`.text` reads all survive per the verified Node/SourceFile surface.
3. Declaration traversal (`includes`):
   - `symbol.getDeclarations()` → `symbol.declarations` (property; both call sites, lines 103 and 138). Same for `aliased.getDeclarations()` → `aliased.declarations` (line 155).
   - Package-origin checks (lines 119, 144, 159): `fileNameMatchesPackage(decl.getSourceFile().fileName, pkg)` → `fileNameMatchesPackage(handle.path, pkg)` — the handle exposes `path` DIRECTLY; never resolve just to read a filename.
   - ImportSpecifier fast path (lines 109-117): `isImportSpecifier(decl)` → `handle.kind === SyntaxKind.ImportSpecifier` (`SyntaxKind` from `typescript/unstable/ast`); only then materialize `let decl = handle.resolve()` (parameterless — resolves against the handle's canonical project) and keep the existing `.parent.parent.parent` walk + `isImportDeclaration`/`isStringLiteral` guards on the resolved Node. A handle that resolves to `undefined` falls through to the `.path` check, never throws.
   - `checker.getSymbolAtLocation(node)` and `checker.getAliasedSymbol(symbol)` survive by name (verified in the Checker class). Keep the existing try/catch around getAliasedSymbol with its comment (line 151-168) — TS5 documented the throw; TS7's behavior here is unverified, and the catch preserves the pinned `returns false when getAliasedSymbol throws` characterization.
4. Windows path-casing edge: `NodeHandle.path` is a canonicalized `Path` (may be lower-cased) while `fileNameMatchesPackage` substring-matches `/node_modules/<pkg>/`; npm package names are lowercase by registry rule, so the match is safe — note this at the helper, do not add case-folding.

**Named discretion point:** whether the `isIdentifier(node)` entry guard (line 66) narrows `node` sufficiently for `node.text`/`getSourceFile()` under the unstable typings, or an `Identifier` narrowing cast is needed — criterion: zero `any`, no non-null assertions on symbol lookups, scoped tests green.

**Test migration** (tests/compiler/imports.test.ts): `parse()` → `languageService.parse('test.ts', code)`; `findIdentifier`'s free-function `ts.forEachChild` → `node.forEachChild` method walks; guards (`isImportSpecifier`, `isImportClause`, `isNamespaceImport`) from `typescript/unstable/ast/is` — NOTE `isImportClause`/`isNamespaceImport` live in the generated guard set; verify their export before use, else test via `node.kind` against `SyntaxKind`. Mock checkers update shape: `getSymbolAtLocation: () => null` stays; the throwing-alias mock's symbol gains `declarations: []` (property) instead of `getDeclarations: () => []`. `afterAll(() => languageService.dispose())`. Every assertion stays semantically identical.

## Reads

- node_modules/typescript/dist/api/sync/api.d.ts — Symbol.declarations: NodeHandle[], NodeHandle {kind, path, resolve}, Checker methods
- node_modules/typescript/dist/ast/is.d.ts — available guards incl. the generated per-node set
- node_modules/typescript/dist/ast/ast.d.ts — Node.parent chain + SourceFile the resolved walk uses
- src/compiler/language-service.ts — parse()/dispose() the tests consume
- tests/compiler/coordinator.test.ts — consumer of imports.all via coordinator; confirms no cross-file test coupling breaks

## Acceptance

- 0 regressions in tests/compiler/imports.test.ts under typescript@7, run scoped; the fast-path (direct import), aliased-import, cache-consistency, and throwing-alias characterizations all hold.

## Checks

- pnpm agent:test tests/compiler/imports.test.ts

## Notes

The mock-checker unit tests cannot exercise real NodeHandle resolution (that needs a live project); the real-checker path is exercised end-to-end by cli-tsgo-emit's fixture test where plugins run against a genuine Project. Do not inflate this item with a live-project integration test — coverage lands where the real checker already flows.
