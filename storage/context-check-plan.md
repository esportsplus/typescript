# analyze `context` channel — Requirements (`R`) for Plain TS

A analyze channel (see `analyze-kernel-plan.md`). **Exploratory** — build after
`exceptions` and `resources` prove the kernel; drop it if the noise floor
disappoints. It is the loosest port of the four, because Effect's `R` is about
*provision* (DI) and plain TS has no provision mechanism to check against — so
this channel checks the half that is portable: making **ambient requirements
visible and validated**.

**The port:** in Effect, a computation's environment needs are in its type; you
cannot run it without providing them. In plain TS, `process.env.STRIPE_KEY`,
module singletons, `Date.now()`, and `Math.random()` are invisible ambient
grabs. This channel infers each function's **requirement set** and validates it
at entry points.

## Requirement kinds (v1: exactly these)

1. **Environment variables** — `process.env.X` / `import.meta.env.X` reads
   (member access with statically known name; dynamic access degrades to a
   logged "reads unknown env"). The high-value check: every reached env read
   must be **declared**:

   ```jsonc
   "channels": { "context": {
     "env": {
       "declared": ["NODE_ENV", "PORT", { "name": "STRIPE_KEY", "requiredIn": ["production"] }],
       "undeclared": "error"
     }
   } }
   ```

   Catches the classic deploy failure — code shipped reading a var nobody set —
   at build time, per entry point ("handler `webhook` requires STRIPE_KEY").
   This is the channel's reason to exist; everything else is a bonus.
2. **Module-level mutable state** — transitive read/write of module-scope `let`
   or mutated module-scope objects, reported as a requirement ("uses singleton
   `connectionPool` from src/db.ts"). Purely informational by default
   (hover/report, no diagnostic); an optional `"forbidWritesFrom"` glob turns
   writes from matching files into diagnostics (e.g. "pure domain code must not
   touch singletons").
3. **Impurity markers** — `Date.now`/`new Date()`, `Math.random`, `crypto`
   randomness, locale/TZ-sensitive APIs, via overlay. Informational: powers a
   `analyze context --report` purity report (which functions are deterministic)
   — useful for test design and for spotting the nondeterminism that makes
   tests flake — and an optional forbid-glob like singletons.

Requirement sets propagate through the call graph like every channel summary
(union join; the sets are small and bounded by kind, so no widening needed
beyond an env-name cap at 64 → "many").

## What this is not (locked)

Not a DI framework, not an effect-purity wall, not taint analysis. No attempt
to model provision/scoping (Effect Layers have no plain-TS counterpart to check
against). If we ever want provision, it arrives as explicit boundary config
("handlers under src/jobs/ may only require: env(QUEUE_URL), singleton(pool)")
— an idea to revisit only after the report mode has real users.

## Diagnostics

Undeclared env: at the read site, with the entry points that reach it as the
chain. Forbid-glob violations: at the read/write site. Everything else lands in
the report and hovers, not squiggles — this channel must earn squiggle
privileges check by check, because ambient-state warnings are where lint tools
classically drown users.

## Milestones

- **C1 — Env requirements.** Read detection, declaration config, per-entry-point
  requirement rollup, undeclared diagnostic, dynamic-access degradation log.
  *Accept:* fixtures — declared ok, undeclared flagged with chain, requiredIn
  environments, dynamic access logged not flagged, propagation through helpers.
- **C2 — Singletons + impurity report.** Kinds 2 and 3, `--report` output
  (per-function requirement sets, sorted), hover integration, forbid-globs.
- **C3 — Editor (requires K3).** Hovers; no quick-fixes beyond "add to
  declared env".

## First step

C1 only. Run against a real deployable project's entry points and compare the
inferred env-var list with its actual deployment config — if it finds one
undeclared variable in real use, the channel has paid for itself.
