---
recommended-model: sonnet
status: PENDING
files-own: [src/compiler/code.ts, src/compiler/imports.ts, tests/compiler/code.test.ts, tests/compiler/imports.test.ts]
tests: [tests/compiler/code.test.ts, tests/compiler/imports.test.ts]
depends-on: [plugin-path-silent-failures]
type: fix
---

# Escape Correctness and Symbol Guard

## Design

Two defects in the helpers plugin authors call to generate code. Both are pure bug fixes with no public
signature change.

**Defect 1 — `code.escape` escapes only the apostrophe (`src/compiler/code.ts:22-24`).** The
implementation is a single `str.replace(/'/g, "\\'")`. Backslash is not escaped, so `code.escape('a\\')`
returns `a\` unchanged; placed inside a single-quoted literal by the `code` template helper, that
trailing backslash escapes the CLOSING quote and the generated code is broken or the remaining source is
swallowed into the literal. `tests/compiler/code.test.ts:57-72` covers apostrophes, the empty string, and
a no-op string only — the hole is entirely untested.

Settled contract: `code.escape` produces a value safe to embed between single quotes in emitted
JavaScript. Escape, in this order and no other (backslash MUST be first or the later replacements are
themselves re-escaped): `\` → `\\`, then `'` → `\'`, then the line terminators that are illegal raw
inside a string literal — `\n` → `\n`, `\r` → `\r`, and U+2028 / U+2029. Keep the module-level regex
constants pattern already used in the file; the added regexes are module-level constants, never inline
literals in the hot path.

Tests in `tests/compiler/code.test.ts`: a trailing single backslash, an embedded `\'` pair, a doubled
backslash, a newline, a CRLF, U+2028, and a round-trip case asserting the escaped value parsed back
through `JSON.parse`-equivalent single-quote semantics yields the original. The existing four cases stay
green unmodified.

**Defect 2 — `getAliasedSymbol` guarded by a swallowing try/catch
(`src/compiler/imports.ts:159-176`).** The `catch { }` carries the comment "getAliasedSymbol can throw
for non-alias symbols" — i.e. the precondition is KNOWN, and exception handling is being used as
control flow for a condition that can be tested directly. Under the repo standard an error-swallowing
catch is not an acceptable guard when the predicate is checkable.

Settled contract: test the precondition instead of catching its violation. `Symbol` in
`typescript/unstable/sync` exposes `readonly flags: SymbolFlags`
(`node_modules/typescript/dist/api/sync/api.d.ts`), so the guard is a flags check for the alias bit
before the call. VERIFY that `SymbolFlags` is exported from `typescript/unstable/sync` and carries an
`Alias` member; the probe is one import and one `tsc --noEmit`. If it is exported, replace the try/catch
with the guard and the catch disappears. If it is NOT exported, that is a report-worthy upstream gap:
keep a catch but narrow it to the single call, re-throw anything that is not the expected non-alias
error, and record the verification result in this item's Notes — do not leave a bare swallowing catch
either way.

Test in `tests/compiler/imports.test.ts`: a non-alias symbol reference asserting `includes` returns the
correct value without relying on a thrown-and-swallowed error, and the existing re-export case
(`includes` true through an aliased re-export) stays green unmodified.

**Ordering (settled).** This item shares `src/compiler/imports.ts` with plugin-path-silent-failures and
runs immediately after it in `## Features` order; the sequential position is the serialization. It does
NOT touch `includes`'s fast-path trust branch — that is the other item's defect and will already be
fixed by the time this runs. Read `includes` as landed and change only the aliased-symbol guard.

## Reads

- src/compiler/index.ts — code and imports are both public exports; their signatures must not change
- node_modules/typescript/dist/api/sync/api.d.ts — the Symbol/SymbolFlags surface the guard is verified against

## Acceptance

All new code.escape cases green including the trailing-backslash and line-terminator cases; the four existing code.escape cases green unmodified; the aliased-symbol guard case green and the existing re-export case green unmodified; 0 regressions in tests/compiler/code.test.ts and tests/compiler/imports.test.ts, run scoped, plus the full suite.

## Checks

- npx tsc --noEmit
