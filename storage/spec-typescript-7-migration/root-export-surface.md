---
type: refactor
recommended-model: sonnet
status: PENDING
validation: critic
depends-on: [coordinator-api-reparse]
files-own: [src/index.ts, README.md, tests/index.test.ts]
tests: [tests/index.test.ts]
priority: P0
api-impact: breaking
---

# Root Export Surface Decision

## Rationale

src/index.ts:1 — `export { default as ts } from 'typescript';` — is the package's ENTIRE root public surface (the file is otherwise empty) and, until the five upstream items land, also the INTERNAL hub every compiler module imports `ts` through (verified: ast.ts:2, imports.ts:1, coordinator.ts:3, language-service.ts:2, vite.ts:3 all `import { ts } from '~/index'`). Under typescript@7 the line still COMPILES but re-exports only `{ version, versionMajorMinor }` — a silent behavioral lie to every consumer. Each module item removes its own `~/index` consumption as part of its own migration; this item reshapes the published surface per Q2 and documents the break.

## Changes

The root module's export set changes per the Q2 answer; the README gains the consolidated TS7 migration/breaking-changes section for the whole package (root export, plugin-facing types, ast helper types, imports Checker/NodeHandle types, coordinator transform signature); a new root test pins the decided surface.

## Design

Settled by Q2 (answered: Option 1 — DROP the root `ts` re-export). Zero discretion remains:

1. src/index.ts: replace line 1 (`export { default as ts } from 'typescript';`) with a bare `export {};` — chosen over a zero-byte file so module-ness stays explicit under the repo's `isolatedModules: true`, and the emitted root artifact keeps a concrete statement, so the package `exports["."]` / `main` / `types` targets continue to resolve to a real module. No `typescript/unstable/*` re-export, no version-only line.
2. tests/index.test.ts (new): `import * as root from '~/index';` then assert the module exposes NOTHING — `expect(Object.keys(root)).toEqual([])` and specifically `expect('ts' in root).toBe(false)`. Plain synchronous assertions; this test spawns no API instance and needs no disposal hooks.
3. README.md: add a `## TypeScript 7 migration` section documenting, for package consumers: the root `ts` export is REMOVED — import `typescript/unstable/*` subpaths directly (`typescript/unstable/ast`, `typescript/unstable/ast/is`, `typescript/unstable/sync`, `typescript/unstable/fs` per need); plugin-facing types (`TransformContext`, `ReplacementIntent`) now carry `typescript/unstable/ast` + `typescript/unstable/sync` identities; `coordinator.transform` takes the `{ checker, program }` project pair; `imports.includes` takes the API `Checker` and symbol declarations are NodeHandles; typescript@^7 ships as a regular `dependencies` entry of this package. One factual section, no changelog narration elsewhere in the file.

## Reads

- package.json — exports["."]/main/types anchoring why the module must survive in all branches
- src/compiler/index.ts — the unchanged `./compiler` surface the README section contrasts against
- README.md — existing structure the migration section slots into
- node_modules/typescript/package.json — the unstable subpath map cited in the README section

## Acceptance

- src/index.ts is exactly the bare `export {};` module — no `ts` binding, no re-exports of any kind.
- tests/index.test.ts pins the empty surface (zero exported keys; no `ts` binding), 0 regressions run scoped.
- README.md documents the removal and the consumer migration path (direct `typescript/unstable/*` imports) plus the full breaking-changes set named in Design.

## Checks

- pnpm agent:test tests/index.test.ts

## Verify

`pnpm agent:test tests/index.test.ts` → exit 0.

## Notes

Critic-routed: acceptance forks on Q2 — the export shape, and therefore the literal pinning assertions, are undecided until the answer lands; once Q2 is answered this item is a zero-discretion sonnet recipe.

Edge justification (why the single dependency is coordinator-api-reparse): no scoped gate loads src/index.ts except this item's own test, so the joint compile proof belongs to build-green-gate — but ONE scoped-gate window is genuinely vulnerable: types-plugin-contract's check runs tests/cli/tsc.test.ts, whose import chain (~/cli/tsc → coordinator → imports + language-service) loads hub-consuming modules that are only guaranteed migrated once coordinator-api-reparse and its dependencies complete. Landing this item's export change inside that window would turn their member-undefined breakage into an import-time crash inside a live gate. ast and vite are loaded by no gate but their own (which runs only after their own migration), so edges from them were removed as padding. The README documents contracts SETTLED BY THIS SPEC, not landed code — safe even when ast/vite land after this item; build-green-gate (which depends on all nine) proves the joint reality before the run ends.
Q2 ANSWERED (Option 1 — drop): the critic-routing rationale above is superseded — the fork is resolved, the item is a zero-discretion recipe, and validation is now deterministic with the scoped tests/index.test.ts check as its full acceptance.
