---
type: test
recommended-model: sonnet
status: PENDING
validation: deterministic
depends-on: none
files-own: [package.json, vitest.legacy.config.ts]
files-shared: [package.json]
tests: [tests/cli/tsc.test.ts, tests/compiler/code.test.ts, tests/compiler/uid.test.ts]
priority: P0
api-impact: none
---

# Baseline Regression Gate

## Rationale

D2 (settled): the regression gate lands before any migration item. The suite already exists — tests/ holds 8 test files + 1 bench file (1,814 LOC, 122 tests) — but it cannot RUN under typescript@7 because `ts.createSourceFile`, `ts.forEachChild`, `ts.findConfigFile` etc. are `undefined` at runtime (measured this session: 52 pass / 70 fail; the 5 failing files are exactly the 5 that call the removed API). The suite is therefore the pre-existing regression gate; what this item MUST add is the engine-facing wiring (`agent:test` / `agent:build`) the validation contract requires, and what it MAY add — Q1 opt-in — is a one-shot proof that the assertions were actually green against live TS5, so a pre-existing red is never misattributed as a migration regression.

## Changes

Test-runner wiring only. Adds the engine-facing test and build entrypoints; optionally (Q1 opt-in) performs a one-shot live-TS5 verification of the existing suite via a temporary aliased dependency, leaving zero residue. No production source changes.

## Design

The existing 1,814-LOC suite IS the regression gate — verified in-tree, git-tracked, and authored green against TS5. This item wires the engine-facing entrypoints; the live-TS5 capture is an OPT-IN extension via Q1, not the default.

**Default (Q1 unanswered or declined — no new dependency):**
1. Add two scripts to package.json: `"agent:test": "vitest run"` (vitest appends file-path args, so `pnpm agent:test <files>` runs scoped — the shape the engine invokes) and `"agent:build": "pnpm build"` (the allowlist-admissible alias the build-green-gate item's deterministic checks require). No `agent:bench` — this spec has zero `type: perf` items.
That is the entire default surface: the 122 existing assertions are the pinned contract as-is.

**Opt-in (Q1 answered YES — user approves the temporary alias), additionally, in order:**
2. `pnpm add -D typescript-legacy@npm:typescript@^5.9.3` (pnpm ONLY — lockfile is pnpm-lock.yaml).
3. Author `vitest.legacy.config.ts`: copy of vitest.config.ts (same `~` → src alias, same `tests/**/*.test.ts` include) plus `resolve.alias: { typescript: 'typescript-legacy' }`. Alias safety, verified: at capture time no source imports `typescript/unstable/*` yet, and the key `typescript` does not remap `typescript-legacy` itself (rollup alias matches exact-or-`/`-suffixed only).
4. Run `pnpm vitest run --config vitest.legacy.config.ts`. Expected: 122/122 green. Any failure is a PRE-EXISTING red: record it verbatim (file, test name, assertion) in the commit message body — never fix it in this item, never let it silently vanish.
5. Record the capture summary line (pass/fail counts, vitest version, typescript-legacy resolved version) in the commit message body — the durable baseline evidence, engine-journaled.
6. Remove the scaffolding before completing: `pnpm remove typescript-legacy` and delete `vitest.legacy.config.ts`. End-state tree delta identical to the default branch (lockfile add/remove nets out).

Do NOT touch vitest.config.ts, any file under tests/, or any file under src/.

## Reads

- vitest.config.ts — the config to clone for the legacy capture variant (alias + include shape)
- package.json — scripts block receiving agent:test; devDependencies receiving/losing the temporary alias
- tests/compiler/coordinator.test.ts — largest characterization file; confirms the suite parses via `ts.createSourceFile` (why the capture needs live TS5)

## Acceptance

- `pnpm agent:test tests/cli/tsc.test.ts tests/compiler/code.test.ts tests/compiler/uid.test.ts` exits 0 — this single predicate proves BOTH the agent:test wiring and 0 regressions in the 3 TS7-green files (this item changes no source).
- The `agent:build` script's wiring is mandated by Design and first exercised by build-green-gate's checks — the full build is red mid-migration by design, so it is deliberately not an acceptance predicate here.

## Checks

- pnpm agent:test tests/cli/tsc.test.ts tests/compiler/code.test.ts tests/compiler/uid.test.ts

## Verify

`pnpm agent:test tests/compiler/code.test.ts tests/compiler/uid.test.ts tests/cli/tsc.test.ts` → exit 0.

## Notes

- Q1 is OPTIONAL with a no-dependency default because the regression gate already exists in-tree (the dispatch's "zero tests" claim was refuted at authoring); the opt-in alias needs the user's Ask-First dependency approval, which the Q1 answer itself constitutes. The opt-in capture's evidence (commit-body summary) is engine-journaled — it is deliberately NOT an acceptance predicate, which is what keeps this item deterministic.
- The `tests` field deliberately lists only the 3 TS7-green files: mid-migration the full suite is red by design, so the scoped gate must not invoke it.
- package.json already carries an odd `"-": "-"` scripts entry — leave it untouched (out of scope).
- Critic (files-own honesty): package.json is this item's ONLY unconditional edit target and is now declared files-own, so the item keeps a writable surface under any plan shape; vitest.legacy.config.ts is created ONLY on the Q1 opt-in branch and is absent under the default answer. It stays in files-shared as well, which is correct only as a wave-0 hub hook - no other item declares it.
FABLE_REPLAN ledger: [{'role':'critic','verdict':'FAIL'},{'role':'replanner','status':'completed'},{'role':'critic','verdict':'FAIL'}]
