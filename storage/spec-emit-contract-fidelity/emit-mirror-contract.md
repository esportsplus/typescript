---
type: fix
recommended-model: opus
status: PENDING
depends-on: e2e-fixture-harness
files-own: [src/cli/tsc.ts, tests/cli/emit-contract.test.ts]
tests: [tests/cli/emit-contract.test.ts, tests/cli/tsc.test.ts]
---

# Mirror Emit Contract Repair

## Rationale
Four verified defects, one root cause: the derived mirror tsconfig `emit()` writes
(`src/cli/tsc.ts:140-144`) hardcodes `rootDir: <mirror>` and inherits the real config's
`include`/`declarationDir` verbatim through `extends`, while only `<mirror>/__emit` is copied back
(`src/cli/tsc.ts:148-150`). Consequences, all at exit code 0 unless noted:
- `.d.ts` silently dropped — `declarationDir: "${configDir}/build"` resolves against the mirror config,
  emits outside `__emit`, and is destroyed with the mirror; a published package ships with no types.
- Output layout gains the rootDir delta — sources sit at `<mirror>/src/` but rootDir is `<mirror>`, so
  every artifact gains a `src` segment: a probe project's entry emits one directory level deeper, nested
  under that extra segment, instead of at the output root — breaking any consumer's
  `main`/`exports`/`types`.
- tsc-alias silently no-ops — it derives output paths from the REAL config's rootDir/outDir relationship,
  finds nothing at the shifted paths, and `~/` specifiers (author-written AND plugin-injected alike) ship
  unresolved.
- A literal-relative `include` hard-fails — `extends` re-resolves it against the mirror as `../src`,
  dragging the REAL untransformed sources into the mirror program where they violate `rootDir` (TS6059,
  exit 2). Verified nuance: `${configDir}`-based includes (the shipped configs) re-resolve to the mirror
  and work TODAY — the repair must not regress them and must not rely on consumers using `${configDir}`.

Blast radius: `d:/template` and `d:/ui` build production artifacts through this exact path and would
publish broken packages silently.

## Changes
The CLI plugin-path emit: how the mirror project's tsconfig is derived and how its outputs are captured
and copied back. No changes to plugin loading, transform application, or the type-error gate.

## Design
**Contract (settled).** For every tsconfig shape — `files`-based or `include`-based (literal-relative or
`${configDir}`), with `rootDir`/`outDir`/`declarationDir` set or defaulted — the plugin path's emitted
artifact tree (paths AND content, across all artifact classes: `.js`, `.js.map`, `.d.ts`, `.d.ts.map`)
matches what `passthrough()` produces for the same project, except that the transformed files' CONTENT
differs by exactly the plugin's transform and `.js.map` CONTENT parity is explicitly out of scope here
(sourcemap-composition owns it — this item asserts map file PATHS only).

**Preserved invariants (settled).** The mirror exists so the CLI never writes transformed content over
real source — the pre-mirror in-place implementation had a SIGKILL corruption window. Do not regress to
in-place emit; the two pinned cases (`tests/cli/tsc.test.ts:195-253`: untouched-original and
never-writes-real-source) must stay green untouched. The type-error gate before emit and the `finally`
mirror cleanup (`src/cli/tsc.ts:154-156`) are unchanged.

**Discretion point 1 — mirror layout derivation.** Two viable shapes: (a) compute the real config's
rootDir→outDir relationship and reproduce it inside the mirror so `__emit` mirrors the real layout
exactly, then copy back; (b) keep sources at their real relative offsets (the copy loop at
`src/cli/tsc.ts:123-138` already does this) and set the mirror `rootDir` to the mirrored equivalent of
the REAL rootDir instead of the mirror root. Criterion: the chosen mechanism must yield tree parity with
the passthrough oracle for all four fixture shapes below, including declaration output captured (redirect
`declarationDir` under the captured output, or copy back from wherever it lands) — implementer decides.

**Discretion point 2 — neutralizing inherited `include`/`exclude`.** Options: override them to empty in
the derived config; remap their patterns into the mirror; or drop `extends` entirely and flatten the
resolved compilerOptions (`api.parseConfigFile` already yields `fileNames` and the resolved options, so
flattening may be cheap). Criterion: `${configDir}`-based configs keep working exactly as today; the
literal-relative-`include` shape exits 0 with correct output; no compilerOption the real config set is
silently dropped — implementer decides.

**Mirror-escape guard (settled outcome, unverified repro).** A source whose `path.relative(root, source)`
begins with `..` (a tsconfig pulling files from outside its own directory) escapes the
`path.join(mirror, relative)` at `src/cli/tsc.ts:125` — with two or more `..` levels the mirror could
write transformed content OUTSIDE itself. Not re-verified; the item verifies it (test or code
inspection). Minimum bar: detect out-of-root inputs and fail loudly with a `@esportsplus/typescript:`-
prefixed error before any write, rather than writing outside the mirror. Full monorepo-external-source
support is out of scope.

**tsc-alias (settled).** No code change expected: `runTscAlias` already runs after emit
(`src/cli/tsc.ts:107`); once the layout matches the real config's rootDir/outDir relationship it finds
the files. Proven by the alias e2e case, not by touching tsc-alias.

**Tests (settled).** Add four plugin-path e2e cases to `tests/cli/emit-contract.test.ts`, each built on
the `tests/cli/fixtures.ts` helper and diffed against the passthrough parity oracle:
1. Shipped-shape fixture (declaration via `tsconfig.package.json`) + prepend-marker plugin → tree parity
   including `.d.ts` for every source; transformed marker present in `.js`.
2. Alias fixture + import-injecting plugin → emitted content carries relative resolved specifiers with no
   `~/` remaining, for BOTH the author-written and the plugin-injected import.
3. Literal-relative `include` fixture (caller-supplied full tsconfig, not extending the shipped configs)
   → exit 0 and tree parity (pins the TS6059 regression).
4. `files` + `rootDir: src` fixture → no `src` segment gain: the fixture's entry `index.js` emits at
   the output root, never nested under an extra `src` segment.
Where a case sets `sourceMap: true`, assert the `.js.map` file PATHS exist at parity positions only.

## Reads
- tests/cli/fixtures.ts — the fixture surface and parity oracle this item consumes
- tests/cli/tsc.test.ts — the pinned mirror invariants and existing flat-shape e2e cases that must stay green
- tsconfig.base.json — the `${configDir}` shapes the repair must keep working
- tsconfig.package.json — the shipped consumer shape (declaration/declarationDir) acceptance targets
- src/compiler/language-service.ts — API lifecycle `build()` shares with the emit path

## Acceptance
The four new e2e cases pass; 0 regressions in tests/cli/emit-contract.test.ts and tests/cli/tsc.test.ts,
run scoped; the two mirror-invariant cases pass unmodified.

## Checks
- npx tsc --noEmit

## Notes

`tests/cli/tsc.test.ts` appears in `tests` as a RUN-ONLY regression guard — this item never edits it:
the Design's settled contract preserves the flat-shape behavior its cases pin, so they must pass
unmodified; its only declared writer in this spec is argv-flag-gating.
Deliberate weld: this item shares `src/cli/tsc.ts` with argv-flag-gating (different functions — `emit()`
here, `main()`/flag routing there) and `tests/cli/emit-contract.test.ts` with its dependency
e2e-fixture-harness; the overlap is a serialization signal, not a `Depends-on` edge. Edge case worth a
one-line note in code review, not new scope: `composite`/`incremental` projects would write
`.tsbuildinfo` referencing mirror paths — the shipped configs set neither, and acceptance is scoped to
the fixture shapes above.
Parity is established PER FIXTURE, not against the single authored baseline case: three of the four shapes above have no authored passthrough reference, so each case builds its OWN fixture twice — once with no plugins to capture the reference tree, once with the plugin — and asserts the two trees are equal. Never hardcode an expected tree for a shape that was never run through passthrough; the run-twice diff IS the oracle, the baseline case only pins the shipped shape.
