---
type: feature
recommended-model: opus
status: PENDING
depends-on: [e2e-fixture-harness, emit-mirror-contract]
files-own: [src/compiler/sourcemap.ts, src/compiler/coordinator.ts, src/compiler/plugins/vite.ts, src/cli/tsc.ts, tests/compiler/sourcemap.test.ts, tests/compiler/coordinator.test.ts, tests/compiler/plugins.test.ts, tests/cli/emit-contract.test.ts]
tests: [tests/compiler/sourcemap.test.ts, tests/compiler/coordinator.test.ts, tests/compiler/plugins.test.ts, tests/cli/emit-contract.test.ts]
---

# Sourcemap Composition for Transformed Files

## Rationale
Verified: a transformed file's emitted `.js.map` carries `sources` pointing at the REAL source while its
mappings were generated against the MIRROR's transformed text — every mapping past an injection point is
off by exactly the injected line count, so breakpoints and stack traces land on the wrong line, at exit
code 0. This is the one defect that is not purely an `emit()` bug: `coordinator.transform`
(`src/compiler/coordinator.ts:204-277`) returns `{ changed, code, sourceFile }` with NO
original→transformed mapping, and the Vite plugin returns `{ code, map: null }`
(`src/compiler/plugins/vite.ts:80`) by construction. Producing that mapping is a NEW capability, not a
bug fix — the highest-uncertainty item in this spec.

## Changes
The transform coordinator gains an original→transformed mapping alongside its result; the CLI emit path
composes it into the maps real tsc produced for the mirror; the Vite plugin returns a real map instead of
`null`. Plugin authors' contract (`transform(ctx) → intents`) is unchanged — the coordinator computes the
mapping itself from the edits it applies.

## Design

**Q1 ANSWERED — full original→JS composition at column granularity, implemented in-repo with NO new
dependency.** The scope decision and its reasoning are settled; nothing below is open.

**Why a dependency is not the answer (settled, verified 2026-07-25).** The defect is design-inherent,
not a TypeScript 7 gap. At `51e0bb3` (the TS5-era implementation) `src/cli/tsc.ts` fed transformed text
to `ts.createProgram(fileNames, options, customHost)` through a custom host that served the transformed
text AT THE REAL FILE PATHS, then called `program.emit()` — the same `sources`-vs-mappings divergence,
with no extra dependency and no temp mirror. TS5 did offer a route that produces correct maps for free —
`program.emit(..., customTransformers)`, where transformers run inside the emit pipeline — but this
plugin contract has been string-and-offset based since day one and never used it. TS7 removes even that
option: `typescript/unstable/sync` exposes no emit and no `customTransformers`, and `Emitter` is
`printNode(node, options): string` and nothing else (`node_modules/typescript/dist/api/sync/api.d.ts`
:334-338). No compiler option can supply this mapping; it must be produced from the edits.

**Why not magic-string (settled — considered and rejected).** `vite` is a devDependency
(`package.json`), so magic-string's presence under `node_modules/.pnpm` is dev-only: promoting it would
add a real runtime dependency to every downstream consumer of this build tool. It also shares the exact
same fidelity ceiling — `overwrite()` emits ONE mapping per replacement because generated text has no
interior correspondence to original text. It buys edge-case hardening and build time, not correctness.
Do not install it, and do not install `@jridgewell/*`; if an implementer believes the edge cases below
cannot be met in-repo, that is a report-and-stop, not an unilateral dependency add.

**Fidelity contract (settled).** For a transformed file:
- Every UNTOUCHED region maps identity at LINE AND COLUMN granularity. This is the majority of every
  file and it must be exact.
- Every EDITED span emits one mapping segment anchored at the span start. This is ground truth, not a
  concession: generated text has no position in the original.
- An emitted `.js.map` for a transformed file must never again carry mappings and a `sources` field that
  disagree. `sources` continues to name the REAL source.

**New module (settled): `src/compiler/sourcemap.ts`.** Three groups of pure, individually testable
functions, no I/O, no state:
1. **VLQ base64 codec** — `decode(mappings: string): number[][][]` and `encode(...)`. Standard
   source-map-v3 VLQ; the reference is the spec, not an import.
2. **Builder** — from the ordered edit list and the original text, produce the original→transformed
   mapping. Walk the untouched regions between edits: each contributes identity segments; each edit
   contributes one segment at its span start. Line/column arithmetic is derived from the offsets the
   coordinator already holds.
3. **Composer** — `compose(originalToTransformed, transformedToJs)`: for each segment of the map real
   tsc produced against the mirror, resolve its (mirrorLine, mirrorColumn) back through map 1 to an
   original position and re-encode. Composition, not string patching.

**Coordinator changes (settled).** `coordinator.transform` currently discards its edits
(`applyIntents`/`applyPrepend`/`applyImports` each return a plain string). It must surface them so the
builder can consume them, and `CoordinatorResult` (`src/compiler/coordinator.ts:11-15`) gains the
resulting mapping. Two constraints that are NOT optional:
- **Per-plugin chaining.** Each plugin's edits are offsets into the PREVIOUS plugin's output, not into
  the original — the pipeline re-parses between plugins (`src/compiler/coordinator.ts:262-273`). Build
  one map per plugin iteration and compose them pairwise in order; a single flat edit list across
  plugins is WRONG and will silently produce off-by-N mappings, which is the exact defect being fixed.
- **applyImports inner loop.** `applyImports` (`src/compiler/coordinator.ts:47-53`) re-parses between
  packages, so each `modify` call is likewise a separate edit generation and composes the same way.
- The `Plugin`/`TransformResult` contract in `src/compiler/types.ts` does NOT change — plugin authors
  are unaffected and the coordinator derives everything from the edits it already applies.

**Edge cases the implementation MUST handle (settled — these are what a library would have bought).**
Each needs a named unit case:
- CRLF line endings (`\r\n` must not count as two line breaks or shift columns).
- A leading BOM.
- Astral-plane characters: source-map columns are UTF-16 CODE UNITS, so a surrogate pair counts as two.
- Empty file; edit at offset 0; edit ending at EOF; two adjacent edits sharing a boundary offset.
- A file where `changed` is true but a plugin produced a zero-length replacement (pure deletion).

**Consumers (settled).**
- `emit()` in `src/cli/tsc.ts` post-processes the `.js.map` artifacts the repaired emit copies back,
  composing each with its file's coordinator mapping. This is why the item depends on
  emit-mirror-contract: composing against wrong-path maps is meaningless.
- `src/compiler/plugins/vite.ts:80` returns the composed map instead of `map: null`, so Vite/Rollup
  chain it natively. Do not widen into any other dev-server behavior.

**sourcesContent (settled, verified).** No tsconfig in this repo currently sets `sourceMap`,
`sourcesContent`, `inlineSources`, or `declarationMap`, so the e2e fixture must enable `sourceMap: true`
explicitly. If `sourcesContent` is ever emitted it would embed the MIRROR text, which no mapping
corrects — the item must assert the emitted map either omits `sourcesContent` or carries the ORIGINAL
source text, and must not leave the transformed text embedded.

**Tests (settled).** `tests/compiler/sourcemap.test.ts` covers the codec (round-trip over the edge-case
table above), the builder, and the composer as pure functions. `tests/compiler/coordinator.test.ts`
covers the mapping the coordinator surfaces for prepend-only, import-injection, replacement with line
growth, replacement with line SHRINK, and multi-plugin chaining. `tests/compiler/plugins.test.ts`
asserts the Vite plugin returns a non-null map when changed and `null` when unchanged. One e2e case in
`tests/cli/emit-contract.test.ts` on a `sourceMap: true` fixture decodes the emitted `.js.map` and
asserts BOTH that post-injection lines resolve to the correct original lines AND that an untouched
column on an untouched line resolves exactly — the column assertion is what separates this from a
line-only fix and it is required.

## Reads
- src/compiler/imports.ts — the import rewrite mechanics whose edits the mapping must account for
- src/compiler/types.ts — the plugin contract that must NOT change (hub file, 5 consumers)
- tests/cli/fixtures.ts — fixture surface for the e2e sourcemap case

## Acceptance
At the fidelity level Q1 selects: mapping unit cases green; Vite plugin returns a non-null (or
deliberately absent, option 3) map; e2e decoded-mapping case green; 0 regressions in
tests/compiler/coordinator.test.ts, tests/compiler/plugins.test.ts, and tests/cli/emit-contract.test.ts,
run scoped.

## Checks
- npx tsc --noEmit

## Notes

If Q1 lands on option 1 (full composition) AND a source-map library is wanted, that dependency add is
Ask-First — surface it before installing, with one ranked pick and a runner-up. Deliberate weld: shares
`src/cli/tsc.ts` with two other items and `tests/cli/emit-contract.test.ts` with two others; the
`depends-on` edges already order the real consumption, the remaining overlap is a serialization signal.
Q1 ANSWERED 2026-07-25 (user decision): full original->JS composition at column granularity, hand-rolled in src/compiler/sourcemap.ts. NO dependency is added — magic-string and @jridgewell/* were both considered and rejected in the Design (vite is a devDependency, so magic-string would be a new RUNTIME dep for every downstream consumer, and it shares the identical fidelity ceiling). An implementer who believes the edge-case table cannot be met in-repo must report-and-stop, never install unilaterally. This supersedes the earlier Ask-First dependency note above.
