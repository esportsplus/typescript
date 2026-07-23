---
type: fix
recommended-model: opus
status: PENDING
depends-on: none
files-own: [src/cli/tsc.ts, tests/cli/tsc.test.ts]
tests: [tests/cli/tsc.test.ts]
---

# Overlay-Mirror Emit — Never Write Real Source

## Rationale
The landed emit path writes transformed content OVER the user's real source files, spawns tsc.js, then restores from in-memory backups. A SIGKILL (unblockable by the installed SIGINT/SIGTERM handlers), a power loss, a hard crash of the spawned child, or any interruption inside the write-window leaves the user's real sources permanently overwritten with transformed (prepended/mangled) content. The TypeScript-7 migration's Design decision 5 mandated replacing this in-place mechanism with an overlay-mirror emit that never writes real source; the implementing seat kept the in-place mechanism, the critic FAILed it on exactly this, and the run was salvaged with this item deferred. This item finishes it.

## Changes
The CLI build pipeline's emit stage: replace the in-place write/backup/restore mechanism with an emit that reads transformed content from an on-disk overlay artifact the spawned tsc.js child can see, leaving real source files untouched at every instant. The signal-handler restore machinery is deleted with the mechanism it existed to undo. The build test block gains a mid-emit source-safety proof.

## Design
Current shape (src/cli/tsc.ts at baseline): `emit(tsconfig, transformedFiles)` resolves the tsgo shim `lib/tsc.js` via `require.resolve('typescript/package.json')`; on `transformedFiles.size === 0` it passes straight through to `spawnTsc(tscJs, ['-p', tsconfig])`; otherwise it backs up each target into a `backups` map, overwrites the real files via `fs.writeFileSync`, installs SIGINT/SIGTERM handlers that call `restore(backups)`, spawns tsc.js, and restores in a `finally`. `restore()` writes backups back over real files. Caller `build()` awaits `emit()`, runs `teardown(snapshot, api, root)`, exits nonzero on failure, else chains `runTscAlias(process.argv.slice(2))`.

Hard constraint (settled): the spawned tsc.js (tsgo) is a SEPARATE PROCESS that reads the REAL filesystem via the tsconfig's files/include globs — an in-process virtual FS cannot reach it. The overlay must therefore be a real on-disk artifact the child reads.

**Discretion point — overlay mechanism (implementer decides).** The prior attempt was critic-FAILed on the in-place mechanism, so the mechanism is deliberately NOT mandated here; only the contract below is settled. Candidates:
- (A) Write transformed files into a temp MIRROR directory and synthesize a derived tsconfig whose rootDir/paths resolve transformed files from the mirror and untransformed files from real source, spawning tsc.js against the derived tsconfig with the real outDir preserved. (A full-mirror variant — copy every input, transformed content where applicable, rootDir at the mirror root, outDir pointed at the real outDir — is an admissible realization of A.)
- (B) Emit from a mirror into a temp outDir, then copy the produced artifacts into the real outDir.

Decision criterion: choose the mechanism that keeps the emitted artifact layout in the real outDir — relative paths, declaration files, sourcemap references — identical to what an in-place build produces for the same project, with the fewest moving parts; if A's derived-tsconfig path mapping cannot preserve that layout for a mixed transformed/untransformed file set, use B.

Settled invariants — the contract, regardless of mechanism:
1. Real source files are NEVER written during emit — at no instant, not merely restored afterward.
2. The `transformedFiles.size === 0` passthrough is preserved unchanged.
3. The SIGINT/SIGTERM handlers, `restore()`, and the `backups` map are DELETED — they exist only to undo in-place writes and are dead code once nothing writes real source.
4. `build()`'s teardown and exit-code propagation are preserved: teardown after emit, nonzero emit exit terminates with that code.
5. tsc-alias still runs after a successful emit, exactly as `build()` chains it today.
6. Any temp mirror/outDir is cleaned up on ALL exit paths — success, type-error gate, and throw.

Test plan: the existing case 'emits transformed sources to outDir and leaves originals untouched' (tests/cli/tsc.test.ts) checks the END-STATE only, not the mid-emit window. Strengthen it or add a sibling that proves invariant 1 during emit — e.g. spy on fs.writeFileSync and assert no call targets a path under the test project's source tree, AND assert the on-disk source bytes are byte-identical to the authored content after the build. Implementer decides spy vs. an equivalent observation (e.g. an mtime/content probe from a plugin hook); criterion: the proof must cover the window WHILE tsc.js runs, not only after `build()` returns.

## Reads

- node_modules/typescript/dist/api/sync/api.d.ts — API/Snapshot/Project lifecycle (updateSnapshot, parseConfigFile, close/dispose) the emit/build restructuring must respect
- node_modules/typescript/dist/api/proto.d.ts — ConfigResponse shape, relevant when synthesizing/parsing a derived tsconfig for mechanism A
- node_modules/typescript/dist/api/fs.d.ts — the in-process FileSystem overlay surface; documents why a virtual FS cannot reach the spawned tsc.js child (separate process, real disk)
- node_modules/typescript/lib/tsc.js — the tsgo emit shim emit() spawns; the overlay mechanism must still invoke it
- node_modules/typescript/package.json — resolved via require.resolve to locate lib/tsc.js

## Acceptance
- A test in tests/cli/tsc.test.ts proves real source files are never written DURING emit (mid-window proof, not end-state only) and that source bytes are unchanged after a transformed build.
- The zero-transform passthrough still spawns tsc.js directly against the original tsconfig.
- `restore()`, the `backups` map, and the SIGINT/SIGTERM handler registrations no longer exist in src/cli/tsc.ts.
- Temp overlay artifacts are removed on success, on the type-error gate, and on throw.
- 0 regressions in tests/cli/tsc.test.ts, run scoped.

## Checks
- pnpm agent:test tests/cli/tsc.test.ts

## Notes
The build test block asserts exact exit codes (0 on success, 1 on the type-error gate) and that no `out/` directory exists after a gated failure — the replacement mechanism must not leak a temp outDir or partial artifacts into the project tree on the failure path. Repo standards apply: no `any`, erasable-syntax-only (no enum/namespace), `import type` for type-only imports, internal `function` declarations, pnpm only.
