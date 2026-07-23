---
type: refactor
recommended-model: sonnet
status: PENDING
validation: deterministic
depends-on: language-service-api-lifecycle
files-own: [src/compiler/ast.ts, tests/compiler/ast.test.ts]
tests: [tests/compiler/ast.test.ts]
priority: P0
api-impact: breaking
---

# AST Helpers onto typescript/unstable/ast

## Rationale

src/compiler/ast.ts pulls `ts` through the `~/index` re-export hub (line 2), so `ts.isIdentifier` / `ts.isPropertyAccessExpression` / `ts.forEachChild` are `undefined` at runtime under typescript@7. The helpers are public (re-exported as `ast` by src/compiler/index.ts) — retyping their signatures onto unstable/ast node types is breaking for typed consumers. All `.text` property reads and the traversal logic survive unchanged: TS7's Node keeps its methods, only the FREE-FUNCTION `ts.forEachChild(node, cb)` must become the METHOD `node.forEachChild(cb)` (dist/ast/ast.d.ts:35-50).

## Design

Exact recipe, zero discretion:

**src/compiler/ast.ts:**
1. Replace line 2 (`import { ts } from '~/index';`) with:
   - `import type { Expression, Node } from 'typescript/unstable/ast';`
   - `import { isIdentifier, isPropertyAccessExpression } from 'typescript/unstable/ast/is';`
   (keep line 1's `import type { Range } from './types';` — Range is untouched by the migration).
2. Retype: `ts.Expression` → `Expression` (lines 6, 32), `ts.Node` → `Node` (lines 33, 50); drop the `ts.` prefix on the guards (lines 7, 11, 36, 41).
3. Line 55: `!!ts.forEachChild(node, child => test(child, fn) || undefined)` → `!!node.forEachChild(child => test(child, fn) || undefined)` — the typed method signature also resolves the former implicit-any on `child`.
4. Exports and all logic (`expression.name`, `inRange`, `property.path`, `test`) stay byte-identical otherwise.

**tests/compiler/ast.test.ts:**
1. Drop `import ts from 'typescript'`; import the guards from `typescript/unstable/ast/is`, node types from `typescript/unstable/ast`, and the language-service module (`~/compiler/language-service`).
2. `parse(code)` helper → `languageService.parse('test.ts', code)` (the TS7 replacement for `ts.createSourceFile` — no in-process parser exists).
3. `findFirst`'s `ts.forEachChild(x, visit)` calls → `x.forEachChild(visit)` (method form); `ts.isIdentifier` predicate references → bare `isIdentifier`; `as ts.Expression` casts → `as Expression`.
4. Add `afterAll(() => languageService.dispose())` so the fork's tsgo child exits.
5. Every `expect(...)` assertion stays byte-identical — this file IS the characterization gate for the module.

## Reads

- node_modules/typescript/dist/ast/ast.d.ts — Node methods (forEachChild/getStart/getText) the helpers rely on
- node_modules/typescript/dist/ast/is.d.ts — guard exports (is.generated re-export carries isIdentifier/isPropertyAccessExpression)
- src/compiler/language-service.ts — parse()/dispose() contract the test helpers consume
- src/compiler/types.ts — Range import stays; confirms no other coupling

## Acceptance

- 0 regressions in tests/compiler/ast.test.ts under typescript@7 (default vitest config, no legacy alias), run scoped; assertions unchanged from the pinned baseline.

## Checks

- pnpm agent:test tests/compiler/ast.test.ts

## Notes

Do not touch src/index.ts here — removing this file's `~/index` consumption is what LETS root-export-surface change that hub later; the decoupling edge is the point.
