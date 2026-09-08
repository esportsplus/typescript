# Shared package workflows

These workflows run against the **calling repository**. Keep package-specific
checks in package.json; changes to release orchestration belong here.

## Package contract and migration defaults

- Declare an exact `packageManager`, for example `pnpm@11.10.0`. The pnpm
  setup action reads it directly. Missing declarations use pnpm 11.10.0 with
  a warning; invalid or non-pnpm declarations fail instead of silently switching.
- Node resolution is the `node-version` workflow input, then `engines.node`,
  then the migration default 26.8.1 with a warning. Semver ranges are supported:
  `>=26` permits future majors. Native packages should pass an exact runtime,
  for example `26.8.1`, while keeping their consumer engine range.
- Define `scripts.verify` to build, typecheck, and run all required tests.
  Missing verify scripts fall back to build and test (when test exists), with
  a warning, so existing callers can migrate incrementally.
- Installations use `pnpm install --frozen-lockfile`. Commit lockfile updates
  alongside dependency changes.
- Publishing retains package lifecycle hooks, including prepublishOnly.
  A package may therefore repeat checks there to protect manual publishing.

## Caller examples

Publish wrapper (`.github/workflows/publish.yml`):

```yaml
name: publish to npm
on:
  release:
    types: [published]
  workflow_dispatch:
  workflow_run:
    workflows: [bump version]
    types: [completed]
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    uses: esportsplus/typescript/.github/workflows/publish.yml@main
    # Optional for native packages:
    # with:
    #   node-version: '26.8.1'
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

NPM_TOKEN is optional and used only for installing private dependencies.
Publishing uses OIDC. Configure npm trusted publishing for the **caller**
repository and its publish.yml filename. The caller must grant id-token: write;
the shared publish job already grants it. Called workflows cannot elevate
permissions beyond the caller.

Bump wrapper:

```yaml
name: bump version
on:
  push:
    branches: '**'
permissions:
  contents: write
jobs:
  bump:
    uses: esportsplus/typescript/.github/workflows/bump.yml@main
```

PR verification and Dependabot wrapper:

```yaml
name: dependabot automerge
on:
  pull_request:
    types: [opened, synchronize, labeled, reopened]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  automerge:
    uses: esportsplus/typescript/.github/workflows/dependabot.yml@main
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The shared verification job reduces permissions to contents: read. Only the
separate merge job can write; it never checks out PR code and matches the tested
PR head before enabling auto-merge. Repository auto-merge and required checks must
be configured. Private dependency tokens for Dependabot belong in Dependabot
secrets as well as Actions secrets where applicable.

## Release behavior

Bumps run only on the default branch. Automatic publishing requires a successful
bump from a push in the same repository on its default branch. Manual publishing
is default-branch-only; prereleases are excluded from the stable release trigger.
The post-bump branch is resolved once at checkout, logged, verified and published
without another checkout. Release events check out their event commit.

Release jobs serialize without cancelling active releases. PR checks cancel
superseded runs. Shared concurrency names deliberately differ from the legacy
caller workflow/ref naming to avoid caller/callee cancellation collisions.
Do not give a caller the same concurrency group as its called workflow.

## Upgrades

Existing @main callers receive changes immediately once pushed. For controlled
rollouts, validate a candidate commit with a caller first, then publish a
dedicated workflow tag such as workflows-v1.0.0 and use that tag or its immutable
commit SHA in consumers. Do not treat documentation of a tag as its creation.
Use additive optional inputs and retain migration defaults across compatible
releases. Breaking contract changes require a new workflow major.

Third-party actions are pinned to commit SHAs and updated centrally by the
weekly GitHub Actions Dependabot configuration. Consumers can enable the same
ecosystem to receive reusable workflow reference updates.

Before promoting a workflow release, run actionlint and exercise a PR check,
a non-default-branch bump (skipped), a failed bump (publish skipped), and a
successful OIDC publish from a caller. Local lint cannot validate npm trust.
