---
recommended-model: opus
status: PENDING
files-own: [src/compiler/imports.ts, src/cli/tsc.ts, tests/compiler/imports.test.ts, tests/cli/tsc.test.ts]
tests: [tests/compiler/imports.test.ts, tests/cli/tsc.test.ts]
depends-on: [emit-mirror-contract, argv-flag-gating, sourcemap-composition]
type: fix
---

# Plugin Path Silent Failure Repair

## Design

Three defects, one theme: the plugin path produces SILENTLY WRONG output at exit code 0. Each is fixed
at its root; none may be papered over with a second fallback.

**Defect 1 — name-only trust fallback in `imports.includes`
(`src/compiler/imports.ts:134-135`).** The fast path checks `names.has(node.text)` against the set of
local names imported from `pkg` in this file, walks the resolved symbol's declarations looking for an
`ImportSpecifier` reaching `pkg` or a `node_modules/<pkg>/` path, and when NOTHING matches falls through
to a bare `return true` under the comment `// If checker failed but name matches direct import, trust
it`. A local binding that SHADOWS an imported name (`import { html } from 'pkg'` at module scope, `let
html = ...` inside a function) resolves to a `VariableDeclaration` outside `node_modules`, matches no
branch, and is reported as originating from the package — so a plugin transform fires on the wrong node.

Do NOT simply delete the `return true` and move on. The fallback was added for a reason and that reason
must be named before it is removed. Required sequence:
1. Replace it with `return false` and run the full suite. Record exactly which cases fail.
2. If nothing fails, the fallback was dead defensive code — delete it, and add the shadowing case below
   as a regression test.
3. If real cases fail, the true defect is symbol RESOLUTION, not the branch: diagnose why the checker
   cannot resolve a legitimately-imported symbol (a likely candidate is a node reached through a
   `languageService.parse` scratch program — `src/compiler/language-service.ts:209-220` builds the
   scratch project with hardcoded `compilerOptions` and a single `files` entry, so its checker cannot see
   `node_modules` at all — rather than through the real project's checker). Fix the resolution path so
   the checker answers correctly, then remove the fallback.
The settled contract either way: `includes` returns true only when the resolved symbol's declaration
chain actually reaches `pkg`. An unresolvable symbol is FALSE — conservative — never "trust the name".

**Defect 2 — invalid plugins silently skipped (`src/cli/tsc.ts:186-204`).** Both the array-element
branch (`:192`) and the single-plugin branch (`:200`) print to `console.error` and then CONTINUE. The
build proceeds with that plugin absent from `plugins`, emits a full artifact tree with the transform
MISSING, and exits 0. A consumer ships untransformed code and nothing in the output says so.

Settled contract: a configured plugin that cannot be loaded or does not satisfy `isPlugin` is a HARD
failure. Emit the `@esportsplus/typescript:`-prefixed error naming the offending `transform` path (and
array index where applicable) and exit 1 BEFORE any transform or emit runs. Discretion: whether
`loadPlugins` throws and `main`'s existing `.catch` (`src/cli/tsc.ts:240-243`) converts it, or
`loadPlugins` returns a failure result `build` inspects — implementer decides; criterion is that
`loadPlugins` stays directly callable from tests without process spawning, since it is exported for
exactly that.

**Defect 3 — `extends` never resolved when detecting plugins (`src/cli/tsc.ts:221-236`).** `main()`
reads the tsconfig with the hand-rolled `stripJsonc` (`src/cli/tsc.ts:286-402`, 117 lines) and reads
`config?.compilerOptions?.plugins` from THAT OBJECT ALONE. No `extends` chain is followed. A plugin
declared in a base config — precisely the shipped `tsconfig.package.json` layering every consumer of
this package uses — is invisible, `pluginConfigs.length === 0`, and the build silently routes to
`passthrough()`: real tsc, no transform, exit 0. Meanwhile `build()` already calls
`api.parseConfigFile(tsconfig)` (`src/cli/tsc.ts:48`), the compiler's own resolving parser.

Required sequence:
1. VERIFY whether the resolved config from `api.parseConfigFile` surfaces `compilerOptions.plugins` with
   `extends` applied. Write the probe; do not assume either way.
2. If it does: derive `pluginConfigs` from the resolved options and DELETE `stripJsonc` entirely along
   with its tests — 117 lines of dead hand-rolled JSONC. Leaving it behind is dead code.
3. If it does not: keep `stripJsonc` for the JSONC read but add explicit `extends` chain resolution
   (relative paths, package-name specifiers via `require.resolve`, and arrays of extends), merging
   `compilerOptions.plugins` from base to leaf. Cover each of those three specifier forms with a test.

**Ordering (settled).** This item runs LAST in `## Features` order and shares `src/cli/tsc.ts` with
emit-mirror-contract, argv-flag-gating, and sourcemap-composition, and `src/compiler/imports.ts` with
nothing else in this spec. The sequential position is the serialization; do not run it concurrently with
those items. It must not change `emit()`, the mirror mechanics, the transform pipeline, or the argv
routing those items own — read them as landed and build on top.

**Tests (settled).**
- `tests/compiler/imports.test.ts`: a shadowing case — module-scope `import { x } from 'pkg'` plus a
  function-scope `let x`, asserting `includes` is FALSE at the inner reference and TRUE at an outer one.
  Plus an unresolvable-symbol case asserting FALSE.
- `tests/cli/tsc.test.ts`: an invalid-plugin fixture (a module exporting `{}`) asserting exit 1, the
  prefixed error, and that NO output directory was created. An array-with-one-invalid-element fixture
  asserting the same.
- `tests/cli/tsc.test.ts`: a fixture whose leaf tsconfig `extends` a base carrying the plugin, asserting
  the transform actually ran (marker present in emitted output) rather than passthrough.

## Reads

- src/compiler/language-service.ts — the scratch project whose hardcoded compilerOptions are the prime suspect for Defect 1's resolution failures
- src/compiler/coordinator.ts — the transform pipeline that consumes imports.includes; must not change
- tsconfig.package.json — the shipped base-config layering Defect 3 makes invisible
- tests/cli/emit-contract.test.ts — landed e2e cases that must stay green; this item never edits it

## Acceptance

The shadowing case, the unresolvable-symbol case, both invalid-plugin cases, and the extends-carrying-plugin case are green; 0 regressions in tests/compiler/imports.test.ts and tests/cli/tsc.test.ts, run scoped, plus the full suite. If Defect 3 resolves through api.parseConfigFile, stripJsonc and its tests are DELETED and no reference to it remains.

## Checks

- npx tsc --noEmit
