---
type: test
recommended-model: sonnet
status: PENDING
depends-on: none
files-own: [tests/cli/fixtures.ts, tests/cli/emit-contract.test.ts]
tests: [tests/cli/emit-contract.test.ts]
---

# E2E Fixture Harness on the Shipped Config Shapes

## Rationale
Every existing e2e case in `tests/cli/tsc.test.ts` `describe('build')` uses the same fixture: one flat
file at the tsconfig's own directory, `files:` not `include:`, no `rootDir`, no `declarationDir`, no
`paths`, no subdirectory, no alias import. That is the ONE shape where the emit defects hide (mirror root
and source root coincide, so the layout delta is zero). The fixtures must instead be built on the SHIPPED
`tsconfig.package.json`/`tsconfig.base.json` shape real consumers (`d:/template`, `d:/ui`) extend. This
item creates the fixture surface the later test items consume, plus the green passthrough-parity oracle
those items diff against.

## Changes
Test infrastructure only — a fixture-builder helper and a new build-e2e suite with one baseline case. No
compiler or CLI behavior changes.

## Design
1. Create `tests/cli/fixtures.ts` — a shared helper, deliberately NOT matching `*.test.*` so vitest
   discovery (`include: ['tests/**/*.test.ts']`, `vitest.config.ts:12`) never runs it as a suite. Exports:
   - `createFixture(dir, options)`: copies the repo's `tsconfig.base.json` and `tsconfig.package.json`
     into `dir` at test runtime (Q4 default — hermetic and in-sync by construction; the copied base uses
     `${configDir}` throughout, which re-resolves to the fixture dir, so `include`/`paths`/`outDir` all
     work in the temp project). Writes the fixture project's own tsconfig at `<fixture>/tsconfig.json` as
     `{ extends: './tsconfig.package.json', compilerOptions: <caller-supplied> }` — callers pass
     `plugins`, `sourceMap`, etc. — OR accepts a full caller-supplied tsconfig object verbatim (later
     items need literal-relative-`include` and `files`+`rootDir` shapes that must NOT extend the shipped
     configs). Writes caller-supplied sources under `<fixture>/src/` inside the temp project.
   - Plugin source-string constants: the existing prepend marker (mirror `tests/cli/tsc.test.ts:166`) and
     an import-injecting plugin whose transform returns an `imports` intent adding a specifier from a
     `~/`-aliased module (e.g. `{ package: '~/runtime', add: [...] }`) — later items consume both.
   - `snapshotTree(dir)`: sorted fixture-relative file paths under a directory, for tree-parity asserts.
2. Create `tests/cli/emit-contract.test.ts` — a cross-cutting build-e2e suite (descriptive non-mirror
   filename inside the mirror tree, per convention). Scaffolding mirrored from the existing
   `describe('build')` block in `tests/cli/tsc.test.ts:160-193`: one shared `new API({ cwd: os.tmpdir() })`
   in `beforeAll` closed in `afterAll`, per-case `fs.mkdtempSync`, `process.exit` mocked to push into an
   `exits[]` array and throw, `process.argv` stubbed per case and restored in `afterEach`.
   For any case asserting alias resolution, stub `process.argv` to
   `[process.execPath, 'esportsplus-tsc', '-p', <fixture tsconfig path>]` — NOT `--noEmit`, which is in
   `skipFlags` (`src/cli/tsc.ts:24`) and makes `runTscAlias` (`src/cli/tsc.ts:264-276`, forwards args
   verbatim) skip tsc-alias entirely. UNVERIFIED, verify before relying on it: that tsc-alias accepts
   `-p <absolute path>` from a foreign cwd. If it does not, fall back to asserting alias resolution via a
   direct `runTscAlias` call with working args, or a spawn with `cwd` set to the fixture — implementer
   picks whichever makes the fixture's aliases actually rewrite.
3. Author ONE green baseline case — the passthrough-parity ORACLE: a fixture on the shipped shape
   (`extends: './tsconfig.package.json'`, no plugins) whose temp-project source directory carries an
   entry `index.ts` importing `'~/util'` beside a `util.ts` sibling. Run
   `await expect(build(tsconfigPath, [], api)).rejects.toThrow(/process\.exit/)` — no
   plugins means zero transformed files, so `emit()` spawns real tsc against the project
   (`src/cli/tsc.ts:113-115`) and tsc-alias runs after it. Assert: `exits` contains 0;
   `snapshotTree` over the fixture's emitted `<fixture>/build` tree returns exactly
   `[index.d.ts, index.js, util.d.ts, util.js]` (declaration comes from the shipped package config; no
   `src` segment; no stray dirs); and the emitted `index.js` at the fixture's output root carries a
   `./`-prefixed `util.js` specifier with no `~/` remaining. This case must pass against the CURRENT code — it
   exercises the healthy passthrough-equivalent branch and pins the contract later items compare against.

## Reads
- tests/cli/tsc.test.ts — scaffolding, shared-API lifecycle, exit-mock and argv-stub patterns to mirror
- src/cli/tsc.ts — build/emit/runTscAlias flow the harness drives
- tsconfig.base.json — shipped base config the helper copies
- tsconfig.package.json — shipped package config the helper copies
- vitest.config.ts — discovery pattern the helper file must not match

## Acceptance
New baseline case green against current code; 0 regressions in tests/cli/emit-contract.test.ts, run
scoped; tests/cli/fixtures.ts is never discovered as a suite.

## Notes
The repo's own `tsc --noEmit` program includes only `src/**/*` (root `tsconfig.json` extends
`tsconfig.package.json`, whose base `include` is `${configDir}/src/**/*`), so new test files never enter
that gate — vitest is their only type/behavior gate. The later plugin-path e2e items depend on this
item's helper and oracle; keep the helper's API small and its assertions byte-precise, because tree
parity against this oracle is how those items prove the emit contract.
