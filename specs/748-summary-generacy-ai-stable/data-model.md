# Data Model

This feature does not introduce database entities. The "data model" is the
state of the npm registry, the changeset directory, and the workspace
`package.json` files — before and after the release.

## Entities

### ReleaseScope

The set of changes drained in this release. Defined by the pinned
`develop` SHA merged to `main`.

| Field | Type | Source | Example |
|-------|------|--------|---------|
| `pinnedDevelopSha` | `string` (40-hex) | `git rev-parse develop` at start of procedure | `e.g., 2dded7b…` |
| `changesetCount` | `number` | `ls .changeset/*.md \| grep -v README \| wc -l` | `16` |
| `mainMergeSha` | `string` (40-hex) | `git rev-parse main` after the `develop → main` merge | (merge commit) |
| `versionPrNumber` | `number` \| `null` | `gh pr list --search "chore: version packages"` | `e.g., 753` |
| `versionPrMergeSha` | `string` (40-hex) \| `null` | `git rev-parse main` after Version PR merge | (merge commit) |

**Validation**:
- `pinnedDevelopSha` MUST match `/^[0-9a-f]{40}$/`.
- `changesetCount` MUST equal 16 at start of procedure (Q1=A); MUST equal 0
  after Version PR is merged.

### ChangesetInventory

The 16 `.md` files in `.changeset/` consumed by `pnpm changeset version`.

| File | Theme | Notes |
|------|-------|-------|
| `feat-744-multi-cluster-cli.md` | cloud-cluster | per-cluster tunnel name + identity, `launch --name` |
| `fix-vscode-tunnel-actual-name.md` | cloud-cluster | #743 |
| `fix-cluster-identity-gh-username.md` | cloud-cluster | #742 |
| `prepare-workspace-lifecycle.md` | cloud-cluster | #739 lifecycle prep |
| `fix-739-post-activation-clone-race.md` | cloud-cluster | #739/#741 clone race |
| `739-pre-approved-device-code.md` | cloud-cluster | device-code pre-approval |
| `fix-737-claude-json-volume-bind.md` | cloud-cluster | #737 claude.json volume |
| `feat-750-identity-split-detector.md` | cloud-cluster | post-spec, staging-verified, drained per Q1=A |
| `propagate-primary-branch.md` | bulk | primary-branch propagation |
| `fix-workspace-deps-leak.md` | bulk | post-#669 workspace deps |
| `fix-orchestrator-republish-clean-deps.md` | bulk | orchestrator republish |
| `bulk-worker-scale-release.md` | bulk | worker-scaler release |
| `bulk-stable-release.md` | bulk | bulk stable release marker |
| `initial-stable-release.md` | bulk | initial stable release marker |
| `release-followup-727-730.md` | bulk | follow-up to #727/#730 |
| `release-followup-workflow-engine.md` | bulk | follow-up workflow engine |

**Validation**:
- Total non-`README.md`, non-`config.json` files in `.changeset/` MUST equal
  16 at start of procedure.
- All 16 files MUST be deleted from `.changeset/` after `pnpm changeset
  version` runs (this is what `changesets/action@v1` commits to the
  Version PR).
- `feat-750-identity-split-detector.md` is included per Q1=A.

### RegistryState (before / after)

The shape of `@generacy-ai/*` dist-tags in the npm registry.

| Field | Before | After (success) | After (rollback) |
|-------|--------|-----------------|------------------|
| `@generacy-ai/control-plane@stable` version | `0.3.0` | new version per changeset bumps (likely `0.4.0` or `1.0.0` depending on bump types) | `0.3.0` (re-pointed via `npm dist-tag add`) |
| `@generacy-ai/control-plane@preview` version | current | unchanged (preview is independent) | unchanged |
| `@generacy-ai/control-plane@latest` version | unspecified | bumped to new version (advanced by workflow's `dist-tag add @latest` step) | NOT moved by rollback |
| `@generacy-ai/control-plane` tarball contents | no `deriveTunnelName` | `deriveTunnelName` present | (last-good) |

Sibling packages (`@generacy-ai/orchestrator`, `@generacy-ai/credhelper`,
`@generacy-ai/credhelper-daemon`, `@generacy-ai/cluster-relay`,
`@generacy-ai/activation-client`, `@generacy-ai/workflow-engine`,
`@generacy-ai/generacy`, `@generacy-ai/config`, etc.) follow the same
shape; `pnpm publish` skips already-at-the-current-version packages
silently.

**Validation**:
- After publish: `npm view @generacy-ai/control-plane@stable version` MUST
  NOT equal `0.3.0` (SC-001).
- After publish: `npm view @generacy-ai/control-plane@stable dist.tarball`,
  unpacked, MUST contain `deriveTunnelName` (SC-002).

### LiveClusterState (verification)

The state of the throwaway `stable`-channel cluster used for SC-003.

| Field | Type | Source | Expected |
|-------|------|--------|----------|
| `vscodeTunnelName` | `string` | relay metadata (via `generacy status` or `/health`) | matches `^g-[0-9a-f]{18}$` |
| `clusterChannel` | `string` | `~/.generacy/clusters.json` entry | `stable` |
| `deploymentMode` | `string` | env var `DEPLOYMENT_MODE` on the cluster | `local` (CLI launch) or `cloud` (deploy) |
| `status` | `'connected' \| ...` | cloud-side cluster status | `connected` |

**Validation**:
- `vscodeTunnelName` MUST match `^g-[0-9a-f]{18}$` (SC-003).
- A name matching `^g-` followed by a projectId-derived prefix (UUID with
  hyphens, or a project-name slug) is FAIL.
- Cluster MUST be destroyed after verification (operator hygiene; not a
  spec gate).

## State transitions

```text
Pre-release                  Mid-release                       Post-release
─────────────                ───────────                       ────────────
.changeset/: 16 *.md                                           .changeset/: 0 *.md
@stable:     0.3.0           pinnedDevelopSha → main           @stable:     new version
                             ↓
                             release.yml (version mode)        deriveTunnelName: present in tarball
                             ↓
                             Version PR opened                 vscodeTunnelName: g-<uuid18> on live cluster
                             ↓
                             (operator reviews + merges)
                             ↓
                             release.yml (publish mode)
                             ↓
                             @stable advanced + @latest advanced
```

The `concurrency` group on `release.yml` (`group: ${{ github.workflow }}`,
`cancel-in-progress: false`) serializes the two runs.

## Relationships

```text
ReleaseScope
  ├── pinnedDevelopSha ◄─── operator selects from `git log develop`
  ├── changesetCount   ─── 16 (Q1=A)
  ├── mainMergeSha     ◄─── `git merge develop → main`
  ├── versionPrNumber  ◄─── changesets/action@v1 (run #1)
  └── versionPrMergeSha ◄── operator reviews + merges Version PR

ChangesetInventory ────► (consumed by) pnpm changeset version
                                                ↓
                                                bumps package.json#version
                                                writes CHANGELOG.md per package
                                                deletes .changeset/*.md

RegistryState ◄──── pnpm -r publish --tag stable (run #2)
                    ◄──── npm dist-tag add @latest (run #2, post-publish step)
                    ◄──── (rollback only) npm dist-tag add @<prev> stable

LiveClusterState ◄──── generacy launch --channel stable
                       (verifies SC-003: vscodeTunnelName shape)
```

## Out-of-Scope Data

- **`preview` dist-tag state**: unchanged by this release; out of scope.
- **Cluster image tags** (`ghcr.io/generacy-ai/cluster-base:stable`,
  `ghcr.io/generacy-ai/cluster-microservices:stable`): rebuilt by a
  *separate* workflow in `cluster-base` / `cluster-microservices` repos
  (`.github/workflows/publish-cluster-*-image.yml` here just *triggers*
  those). Image rebuild is NOT a gate on this release per spec §Out of
  Scope.
- **Per-package CHANGELOG.md content**: written by `changesets/action@v1`
  in the Version PR; the operator reviews these but does not hand-author
  them.
- **`npm provenance` attestations**: already produced by `release.yml`'s
  `--provenance` flag and `id-token: write` permission. Verified via
  `npm view <pkg>@stable --json | jq '.dist.attestations'` if needed; not
  a primary acceptance gate here.
