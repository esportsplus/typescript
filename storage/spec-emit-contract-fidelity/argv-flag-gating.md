---
type: fix
recommended-model: opus
status: PENDING
depends-on: none
files-own: [src/cli/tsc.ts, tests/cli/tsc.test.ts, tests/cli/emit-contract.test.ts]
tests: [tests/cli/tsc.test.ts, tests/cli/emit-contract.test.ts]
---

# Argv Flag Gating on the Plugin Path

## Rationale
`main()` (`src/cli/tsc.ts:214-244`) never inspects `process.argv`: it finds the tsconfig, and if plugin
configs exist goes straight to `build()`. The `skipFlags` set (`src/cli/tsc.ts:24`) is consulted ONLY
inside `runTscAlias` (`src/cli/tsc.ts:264-276`), after the build already emitted. Verified: `tsc --noEmit`
in a plugin project ran a FULL build, wrote artifacts, and exited 0; `--version`, `--help`, `--init`,
`--showConfig` behave the same; `--watch` is silently a one-shot build. Any plugin-using package whose
test script is `tsc --noEmit && vitest run` gets a full emit on every test run. The no-plugin
`passthrough()` path forwards argv correctly and is unaffected.

## Changes
CLI entry flag handling on the plugin path only: informational flags route to real tsc, `--noEmit`
suppresses artifact output while keeping the transform+typecheck gate, `--watch` fails fast. The
transform pipeline, emit mechanics, and passthrough path are untouched.

## Design
**Contract (settled).**
- Informational flags — `--help`/`-h`, `--version`/`-v`, `--init`, `--showConfig` — behave on the plugin
  path exactly as on the passthrough path: forwarded to real tsc, no plugin build, no emit, no tsc-alias.
- `--noEmit` runs the full transform + typecheck pipeline (the transformed-program diagnostics gate at
  `src/cli/tsc.ts:81-97` is precisely what `--noEmit` should exercise) but writes NO artifacts and skips
  tsc-alias; exit code reflects diagnostics (0 clean, 1 on errors). Both `--noEmit` and `-noEmit`
  spellings, matching the existing `skipFlags` set.
- `--watch` on the plugin path (Q3 default): exit 1 with a clear `@esportsplus/typescript:`-prefixed
  error naming the limitation — never a silent one-shot build.

**Discretion point — gating placement.** Whether the routing lives entirely in `main()` (flags checked
before `build()` is ever called, with a `noEmit` option threaded into `build()`), or `build()` gains an
options parameter the tests drive directly, or flag parsing is extracted into an exported helper unit
tests cover — implementer decides. Criterion: `build()` must remain directly callable from tests without
process spawning, and the existing direct-call e2e cases must stay green. `build`'s export is
test-surface only (`package.json` `exports` never exposes `./cli/*`), so an added optional parameter is
not a public-API change.

**Known interaction (settled awareness).** The existing build suite stubs
`process.argv = [process.execPath, 'esportsplus-tsc', '--noEmit']` (`tests/cli/tsc.test.ts:179`) — its
original purpose was making `runTscAlias` skip. This item changes what that stub MEANS: if `--noEmit`
suppression is read from `process.argv` inside `build()`, the emit-asserting cases would stop emitting
and fail. Update the stub in those cases (or thread the option explicitly) so every existing case keeps
asserting what it asserts today.

**Tests (settled).** New cases in `tests/cli/tsc.test.ts`:
- `--noEmit` on a plugin project: no output directory created, type errors still gate with exit 1, clean
  project exits 0.
- Informational-flag routing: the plugin path defers to passthrough/real tsc (unit-test the routing
  decision if parsing is extracted; at minimum assert no plugin build occurs).
- `--watch`: exit 1 and the prefixed error message.

## Reads
- src/compiler/language-service.ts — findConfig used by main() before routing
- src/constants.ts — PACKAGE_NAME for the error-message prefix

## Acceptance
New flag-gating cases green; 0 regressions in tests/cli/tsc.test.ts, run scoped; existing emit-asserting
cases still assert emission.

## Checks
- npx tsc --noEmit

## Notes

Deliberate weld: shares `src/cli/tsc.ts` with emit-mirror-contract (different functions) — a
serialization signal, not a dependency edge; neither item consumes the other's artifacts. If Q3 is
answered "implement watch", this item's `--watch` clause is superseded and watch support returns through
spec:create as its own designed item — do not improvise watch mode inside this fix.
Second surface with the same interaction: by the time this item runs, e2e-fixture-harness and emit-mirror-contract have authored five build-e2e cases in tests/cli/emit-contract.test.ts whose argv stubs follow the same --noEmit pattern mirrored from tests/cli/tsc.test.ts. Those cases assert EMITTED trees, so noEmit suppression read from process.argv silences them exactly as it silences the cases here. That suite is declared in files-own and tests for precisely that reason: repair its stubs too, and every case in both files must still assert what it asserts today.
