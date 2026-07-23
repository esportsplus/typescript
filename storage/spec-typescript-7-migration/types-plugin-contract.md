---
type: refactor
recommended-model: sonnet
status: PENDING
validation: deterministic
depends-on: baseline-regression-gate
files-own: [src/compiler/types.ts]
tests: [tests/cli/tsc.test.ts]
priority: P0
api-impact: breaking
---

# Types: Plugin-Facing Contract onto typescript/unstable

## Rationale

src/compiler/types.ts embeds `ts.SourceFile` / `ts.Node` / `ts.TypeChecker` / `ts.Program` directly in the plugin-author-facing contract (`TransformContext`, `ReplacementIntent`) via `import type ts from 'typescript'` — a type-only import whose members no longer exist on typescript@7's root entry (it exports only `{ version, versionMajorMinor }`). Every other migration item's compile depends on this contract landing first. Breaking for third-party plugin authors: the type identities move to the `typescript/unstable/*` declarations (the package is published, private: false).

## Design

Exact mechanical swap — zero discretion:

1. Replace line 1 (`import type ts from 'typescript';`) with:
   - `import type { Node, SourceFile } from 'typescript/unstable/ast';`
   - `import type { Checker, Program } from 'typescript/unstable/sync';`
2. Retype the four embedded references:
   - `ReplacementIntent.generate: (sourceFile: SourceFile) => string` (was ts.SourceFile, line 41)
   - `ReplacementIntent.node: Node` (was ts.Node, line 46)
   - `TransformContext.checker: Checker` (was ts.TypeChecker, line 52)
   - `TransformContext.program: Program` (was ts.Program, line 54)
   - `TransformContext.sourceFile: SourceFile` (was ts.SourceFile, line 56)
3. Nothing else changes: `ImportIntent`, `Plugin`, `PluginFactory`, `Range`, `Replacement`, `SharedContext`, `TransformResult` and the export statement stay byte-identical. src/compiler/index.ts's `export type * from './types'` (line 7) needs no edit — the re-exported NAME set is unchanged; only the type identities behind them move.

Verified API grounding: `Node` keeps its methods (getStart/getText/forEachChild — dist/ast/ast.d.ts:35-50), `SourceFile` extends Node with statements/text/fileName (dist/ast/ast.d.ts:62-75), `Checker`/`Program` are classes exported from dist/api/sync/api.d.ts.

## Reads

- node_modules/typescript/dist/ast/ast.d.ts — Node + SourceFile declarations the contract retypes onto
- node_modules/typescript/dist/api/sync/api.d.ts — Checker + Program class declarations
- src/compiler/index.ts — confirms the re-export surface (`export type * from './types'`) needs no edit
- node_modules/typescript/package.json — exports map proving the `typescript/unstable/ast` and `typescript/unstable/sync` subpaths resolve

## Acceptance

- src/compiler/types.ts compiles standalone under typescript@7 with zero references to the retired root entry.
- 0 regressions in tests/cli/tsc.test.ts (the one TS7-green suite that transitively imports this contract via ~/cli/tsc → ~/compiler/coordinator), run scoped.

## Checks

- npx tsc --noEmit --strict --target es2024 --module esnext --moduleResolution bundler --skipLibCheck src/compiler/types.ts
- pnpm agent:test tests/cli/tsc.test.ts

## Notes

Downstream consumers (coordinator, cli, vite, plugins/tsc) still reference these names through their unchanged import statements; their own migrations land in later items — this item must not touch them. The single-file tsc check works because post-swap types.ts imports only `typescript/unstable/*` (resolvable via `--moduleResolution bundler` without the repo's `~` paths).
