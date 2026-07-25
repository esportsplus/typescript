---
type: chore
recommended-model: sonnet
status: PENDING
depends-on: none
files-own: [package.json, pnpm-lock.yaml]
---

# Pin typescript to an Exact Version

## Rationale
Every compiler import in this package sits on `typescript/unstable/*` — Microsoft's explicitly-unstable
API surface — while `package.json` declares `typescript: ^7.0.2` (installed resolution: 7.0.2). Any 7.x
minor published upstream can break every import in this package and, transitively, the build path of
every downstream consumer. A dependency-range change is an Ask-First decision, so this item is gated on
Q2 rather than applied by default.

## Changes
Dependency manifest only — no source, no behavior.

## Design
On a Q2 "pin" answer:
1. In `package.json` `dependencies`, change `"typescript": "^7.0.2"` to `"typescript": "7.0.2"`.
2. Run `pnpm install` to sync `pnpm-lock.yaml` (the lockfile names pnpm — never npm).
3. Confirm the installed resolution is unchanged (7.0.2 both before and after — this is a range
   narrowing, not an upgrade), so no behavior shift is possible.
On a Q2 "keep caret" answer this item is rejected, not silently skipped.

## Acceptance
`package.json` carries the exact version, `pnpm-lock.yaml` is in sync (`pnpm install` reports no
changes on a second run), and the installed `typescript` resolution is byte-identical to the baseline.

## Checks

- npx tsc --noEmit
- pnpm agent:build
- pnpm agent:test

## Notes

Future bumps become deliberate: raise the pin, run the full suite plus the emit-contract e2e cases, then
commit — the e2e suite this spec adds is exactly the harness that makes an unstable-API bump verifiable.
Q2 ANSWERED 2026-07-25 (user decision): pin exact 7.0.2. Verified against the installed tree — node_modules/typescript is 7.0.2, so the pin records the resolution already in use and no reinstall drift is expected.
