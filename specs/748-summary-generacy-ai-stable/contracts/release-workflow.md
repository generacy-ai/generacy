# Contract: `.github/workflows/release.yml`

The release is driven by an **existing** workflow. This document captures the
trigger contract (inputs, modes, side effects) the operator relies on, NOT a
specification of new behavior. The workflow file is not modified by this
issue.

## Trigger

```yaml
on:
  push:
    branches: [main]
```

Workflow runs every time `main` advances. There is **no `workflow_dispatch`**
trigger and **no inputs**. Mode selection is data-driven from the contents
of `.changeset/` at the time the run starts.

## Modes (mutually exclusive)

The `Determine workflow mode` step decides which mode runs:

```bash
if [ -z "$(find .changeset -name '*.md' ! -name 'README.md' 2>/dev/null | head -1)" ]; then
  publish=true   # publish mode
else
  publish=false  # version mode
fi
```

### Version mode (`publish=false`)

**When**: At least one `.md` file (other than `README.md`) exists in
`.changeset/`.

**Steps executed**:
1. `actions/checkout@v6`
2. `pnpm/action-setup@v4`
3. `actions/setup-node@v4` (Node 22, registry npmjs.org)
4. `pnpm install --frozen-lockfile`
5. `pnpm -r run --if-present build` + `pnpm build`
6. `Determine workflow mode` → `publish=false`
7. `Create Version PR` via `changesets/action@v1`:
   - `version: pnpm changeset version`
   - `title: 'chore: version packages'`
   - `commit: 'chore: version packages'`
   - `env.GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`

**Side effects**:
- A PR titled "chore: version packages" is opened (or updated, if it
  already exists) against `main`. The PR commit:
  - Deletes every `.md` in `.changeset/` (except `README.md`).
  - Bumps `version` in every affected `package.json`.
  - Writes/updates `CHANGELOG.md` per affected package.

**No publish runs in version mode.**

### Publish mode (`publish=true`)

**When**: No `.md` files (other than `README.md`) exist in `.changeset/`.

**Steps executed**:
1. `actions/checkout@v6`
2. `pnpm/action-setup@v4`
3. `actions/setup-node@v4` (Node 22, registry npmjs.org)
4. `pnpm install --frozen-lockfile`
5. `pnpm -r run --if-present build` + `pnpm build`
6. `Determine workflow mode` → `publish=true`
7. `Verify no workspace protocol leaks in packed tarballs`:
   - `node scripts/verify-pack-no-workspace-deps.js`
   - **Fails the run** if any packed tarball still contains `workspace:`
     deps (#669 guard).
8. `Publish to npm`:
   - `pnpm -r --filter '!generacy-extension' publish --tag stable --no-git-checks --provenance`
   - `env.NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
   - Skips packages whose `version` is already on the registry (so
     re-runs are idempotent).
   - Publishes with `--provenance` (OIDC-attested; requires `id-token:
     write` permission, which is set at the workflow level).
9. `Advance @latest dist-tag for all published packages`:
   - For each `packages/*/package.json`: read `name` + `version`, then
     `npm dist-tag add <name>@<version> latest`. Idempotent.

**Side effects**:
- Each non-private workspace package gets a new `@stable` tarball at the
  bumped version.
- `@latest` advances to the same version per package.
- `publish-devcontainer-feature.yml` is triggered (via `needs.release.if:
  needs.release.outputs.published == 'true'`) to publish the devcontainer
  feature on the `stable` mode.

## Permissions

The workflow runs with:

```yaml
permissions:
  contents: write          # for Version PR commits
  pull-requests: write     # for Version PR creation
  id-token: write          # for npm provenance OIDC
  packages: write          # for downstream devcontainer-feature publish
```

## Concurrency

```yaml
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false
```

Two `push: main` events are serialized; the second waits for the first to
finish. This matters during the version→publish handoff: if the Version PR
merges while a stale run is still finishing, the next run picks up the
post-merge state cleanly.

## Required secrets

| Secret | Used by | Required for |
|--------|---------|--------------|
| `GITHUB_TOKEN` (auto-provided) | `changesets/action@v1`, `gh dist-tag` (none here, but `npm` uses it via `node-auth-token`) | Version PR creation |
| `NPM_TOKEN` | `Publish to npm`, `Advance @latest dist-tag` | npm registry auth |

## Failure modes (operator guidance)

| Failure | Likely cause | Operator action |
|---------|--------------|-----------------|
| `verify-pack-no-workspace-deps.js` fails | A package's published tarball would contain a `workspace:` literal — a regression of the #669 root cause. | DO NOT merge a workaround. File a bug. The publish step is intentionally gated. |
| `pnpm publish` fails with 403 | `NPM_TOKEN` expired or doesn't have publish rights on `@generacy-ai/*`. | Rotate the token in repo settings, re-run the job. |
| `pnpm publish` partial failure (some packages published, others not) | Network blip, registry hiccup. | Re-run the publish job; `pnpm publish` skips already-at-version packages, so it's safe to re-run. |
| Version PR exists but conflicts with `main` | A merge to `main` (or `develop` → `main` re-cut) happened mid-release. | Hold further `develop`/`main` merges per Q3=B. Close the conflicted Version PR; the next `push: main` will reopen a fresh one. |

## Out-of-contract behavior

The following are NOT contracts of `release.yml` and are tracked elsewhere:

- Cluster image rebuilds: `.github/workflows/publish-cluster-*-image.yml`
  (separate workflows that dispatch builds in `cluster-base` and
  `cluster-microservices` repos based on GHCR tag drift).
- `@preview` dist-tag updates: `.github/workflows/publish-preview.yml`
  (hardened separately in #749).
- Cloud-side cluster status / `vscodeTunnelName` propagation: relay
  metadata + cloud-side wizard schema. Verified via SC-003 against a live
  cluster; not part of this workflow's surface.
