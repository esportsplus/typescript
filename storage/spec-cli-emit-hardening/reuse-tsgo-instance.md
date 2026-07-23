---
type: refactor
recommended-model: opus
status: PENDING
depends-on: overlay-mirror-emit
files-own: [src/cli/tsc.ts, tests/cli/tsc.test.ts]
tests: [tests/cli/tsc.test.ts]
---

# Reuse the tsgo/API Instance Across Builds

## Rationale
Every `build()` call spawns a fresh tsgo Go child process (`new API({ cwd: root })`) and tears it down at the end of the call, and each emit spawns a separate tsc.js child. The build test block runs `build()` across its cases SERIALLY, paying a tsgo cold-start plus up to one tsc.js subprocess per case — the slowest gate in the repo. Reusing the tsgo instance (or safely parallelizing the cases) removes redundant process spawns and cuts suite wall-clock without weakening any assertion.

## Changes
The CLI build pipeline's API lifecycle: allow the tsgo API instance to be supplied by the caller instead of unconditionally created and destroyed per `build()` call, and restructure the build test block so its cases stop paying serial per-case tsgo cold-starts — either by sharing one injected instance or by decoupling the process-global mocks and running the cases concurrently. This item consumes overlay-mirror-emit's REVISED emit/build process model (how emit spawns and how `build()` manages the API/emit lifecycle) and builds directly on that shape.

## Design
Current shape (at baseline; overlay-mirror-emit revises the emit internals first): `build()` creates `api = new API({ cwd: root })`, takes `snapshot = api.updateSnapshot({ openProjects: [tsconfig] })`, resolves the project, transforms, gates diagnostics, emits, and always ends in `teardown(snapshot, api, root)` (snapshot.dispose + api.close + languageService.dispose). The test block `describe('build')` (tests/cli/tsc.test.ts) has 3 it() cases — emit-and-originals-untouched, JSONC tsconfig, type-error gate — whose shared `beforeEach` mutates process-global state: it reassigns `process.argv` and installs `vi.spyOn(process, 'exit')` pushing into a shared `exits` array.

Hard constraints (settled):
1. `it.concurrent` on the build cases is NOT safe as-authored: the shared `beforeEach` races on `process.argv` and the shared `exits` spy. Any parallelism plan must FIRST decouple those global mocks.
2. `build()` owns its API lifecycle internally today. Sharing one tsgo process across cases means refactoring `build()` to accept an OPTIONAL injected API while keeping the existing public 2-arg call shape `build(tsconfig, pluginConfigs)` working unchanged; when the API is injected, `build()` must not close what it does not own (the injector closes it), while the 2-arg path keeps today's create-and-teardown behavior exactly.
3. Do NOT weaken what the tests verify: each case keeps its own tmpDir + tsconfig + isolation; the emit-vs-gate assertions and exact exit codes (0 vs 1) stay unchanged; zero assertion changes.

**Discretion point — reuse strategy (implementer decides).** Candidates:
- (a) Decouple the global mocks (per-case argv handling and a per-case exit spy, no shared mutable arrays), then run the build cases with `it.concurrent` → parallel spawns absorb the cold-starts.
- (b) Refactor `build()` per constraint 2 to accept an injected API; the test block opens ONE API in `beforeAll`, reuses it per case via `updateSnapshot({ openProjects })`, and closes it once in `afterAll` → one tsgo process total.

Decision criterion: prefer the option that eliminates more redundant process spawns per suite run with the smaller public-surface change and no residual global-state coupling between cases; if (b)'s snapshot reuse across per-case tmpDir projects proves unreliable (stale project state across updateSnapshot calls), fall back to (a). The options compose — landing (b) does not forbid also decoupling the mocks — but the acceptance requires only one landed strategy.

Test plan: no new assertions are required beyond keeping the existing ones byte-equivalent in meaning; the deliverable evidence is the scoped suite green plus a before/after wall-clock comparison of `pnpm agent:test tests/cli/tsc.test.ts` recorded as a Note (see Acceptance). This is deliberately NOT a `type: perf` item: the repo has no product-hot-path benchmark harness, so the win is verified by spawn-count reasoning + suite wall-clock, not a bench-gate.

## Reads
- node_modules/typescript/dist/api/sync/api.d.ts — API constructor, updateSnapshot/openProjects, close/dispose semantics governing safe instance reuse
- tests/compiler/language-service.test.ts — models the languageService/API lifecycle and parse/dispose patterns the sibling tests use

## Acceptance
- The public 2-arg call shape `build(tsconfig, pluginConfigs)` still works unchanged (existing callers untouched).
- Zero assertion changes in tests/cli/tsc.test.ts: each build case keeps its own tmpDir + tsconfig, the emit-vs-gate distinctions, and the exact exit codes (0 vs 1).
- 0 regressions in tests/cli/tsc.test.ts, run scoped.
- A before/after wall-clock of `pnpm agent:test tests/cli/tsc.test.ts` (baseline captured before this item's changes) is recorded in the completion Note/changelog Deviations.

## Checks
- pnpm agent:test tests/cli/tsc.test.ts

## Notes
Depends on overlay-mirror-emit: it consumes that item's revised emit()/build() process model — overlay-mirror-emit restructures how emit spawns and how build() manages the API/emit lifecycle, and this refactor builds on that revised shape; both items also edit the same two files, so they run as a sequential weld in one unit. If strategy (b) is chosen, injected-API ownership must be unambiguous: the creator closes; `build()` closes only an API it created. Repo standards apply: no `any`, erasable-syntax-only, `import type` for type-only imports, pnpm only.
