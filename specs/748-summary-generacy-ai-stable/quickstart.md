# Quickstart: Releasing `@generacy-ai/*@stable`

Operator runbook for cutting a `stable` release that drains all pending
changesets. The workflow is already wired; this document is the sequence.

## Prerequisites

- Push access to `main` on `generacy-ai/generacy`.
- Repo `NPM_TOKEN` is valid (check the most recent `release.yml` run; if
  the last `Publish to npm` step succeeded, the token is good).
- `pnpm`, `gh`, `git`, `node`, and the `generacy` CLI installed locally
  (you need `generacy launch`/`destroy` for the SC-003 step).

## Step 1 — Pre-flight checks

```bash
# Confirm 16 pending changesets (Q1=A).
ls .changeset/*.md | grep -v README.md | wc -l
# → 16

# Confirm current @stable is 0.3.0 (the bug we're fixing).
npm view @generacy-ai/control-plane@stable version
# → 0.3.0

# Confirm @preview is current (the staging baseline).
npm view @generacy-ai/control-plane@preview version
# → 0.0.0-preview-... (recent timestamp)
```

If `.changeset/` shows ≠ 16 files, stop and clarify scope (Q1 may need
re-answering).

## Step 2 — Pin and merge `develop → main`

```bash
# Pin the develop SHA you're cutting. Capture it for SC-002 verification.
git fetch origin
PINNED=$(git rev-parse origin/develop)
echo "Release scope: $PINNED"

# Announce operational freeze ("release in progress, hold develop/main
# merges until Version PR lands").

# Merge to main. Use a PR or a fast-forward; either is fine.
gh pr create \
  --base main \
  --head develop \
  --title "chore: cut release at $PINNED" \
  --body "Drains 16 pending changesets to @generacy-ai/*@stable."
# Then merge the PR (squash or merge commit — either is fine; the workflow
# triggers on push: main regardless).
```

**Operational freeze stays in effect until the Version PR (next step) is
merged.**

## Step 3 — Watch the workflow open the Version PR

```bash
# release.yml fires on push: main, detects 16 pending changesets, runs
# `pnpm changeset version` in version mode, opens a Version PR titled
# "chore: version packages".
gh run watch -e push --workflow release.yml

# When complete, find the Version PR.
gh pr list --search "chore: version packages" --base main
```

**Expected duration**: ~5–10 minutes (install + build + version + push).

## Step 4 — Review and merge the Version PR

Review the PR's diff. Check:

- `.changeset/*.md` (16 files) are deleted.
- `packages/*/package.json` versions are bumped past 0.3.0. Bump types
  match the changeset annotations (patch/minor/major).
- `packages/*/CHANGELOG.md` entries are appended for each package touched
  by a changeset.
- No unexpected `package.json` mutations (e.g., dependency rewrites).

```bash
# Merge the Version PR.
gh pr merge <PR#> --squash --delete-branch
```

**Operational freeze can be lifted now** — the release scope is committed.

## Step 5 — Watch the workflow publish to npm

```bash
# release.yml fires again on push: main (Version PR merge), detects 0
# pending changesets, runs verify-pack → pnpm -r publish --tag stable.
gh run watch -e push --workflow release.yml
```

Watch for:

- `Verify no workspace protocol leaks in packed tarballs` — must pass.
- `Publish to npm` — should succeed across all non-private packages.
- `Advance @latest dist-tag for all published packages` — idempotent
  per-package dist-tag moves.

**Expected duration**: ~10–15 minutes (install + build + verify + publish
+ dist-tag advance per package + downstream devcontainer-feature publish).

If `Publish to npm` partially fails (network blip), re-run just the failed
job from the GitHub Actions UI. `pnpm publish` skips already-at-version
packages so re-runs are safe.

## Step 6 — Tarball verification (SC-002)

```bash
# Confirm @stable is no longer 0.3.0.
NEW=$(npm view @generacy-ai/control-plane@stable version)
echo "New @stable: $NEW"
[ "$NEW" != "0.3.0" ] && echo "OK: bumped past 0.3.0" \
  || (echo "FAIL: still at 0.3.0"; exit 1)

# Download tarball and grep for deriveTunnelName.
TARBALL=$(npm view @generacy-ai/control-plane@stable dist.tarball)
curl -sL "$TARBALL" | tar -xzO --wildcards 'package/dist/**/*.js' 2>/dev/null \
  | grep -q 'deriveTunnelName' \
  && echo "OK: deriveTunnelName present" \
  || (echo "FAIL: deriveTunnelName missing"; exit 1)
```

If SC-002 fails: the publish skipped or fragmented. Re-check the workflow
log, identify the affected package, and either re-run the workflow or
follow the rollback procedure (Step 8).

## Step 7 — Live cluster verification (SC-003)

```bash
# Launch a throwaway stable-channel cluster.
TS=$(date +%s)
NAME="release-verify-$TS"
generacy launch --channel stable --name "$NAME"

# Wait for the cluster to connect (workflow streams "Go to:" device-code URL;
# complete activation in the browser).

# Inspect relay metadata. vscodeTunnelName is surfaced via /health and
# `generacy status`.
TUNNEL=$(generacy status --json 2>/dev/null | jq -r '.vscodeTunnelName // empty')
echo "vscodeTunnelName: $TUNNEL"

# Confirm shape: must match g-<18 hex>.
echo "$TUNNEL" | grep -E '^g-[0-9a-f]{18}$' \
  && echo "OK: UUID-derived tunnel name (SC-003)" \
  || (echo "FAIL: tunnel name not UUID-derived"; exit 1)

# Tear down.
generacy destroy --yes
```

If `vscodeTunnelName` is missing entirely: the cluster image was not
rebuilt against the new `@stable`. File a follow-up on the cluster-image
side (`cluster-base` repo); the npm publish itself is still good.

If `vscodeTunnelName` is projectId-derived (UUID with hyphens, or a
project-name slug): the image was rebuilt but resolved an old
`@generacy-ai/control-plane` version. Verify image pull and the
`package.json` version in the running container. This was the #746 failure
mode — investigate before declaring victory.

## Step 8 — Rollback (if a regression surfaces)

```bash
# Identify affected packages from incident reports.
PKG=@generacy-ai/control-plane

# Find the previous good version (typically the version just before the
# new one we just published; for the cloud-cluster line this is 0.3.0).
PREV=0.3.0

# Re-point @stable. Instant, non-destructive.
npm dist-tag add "$PKG@$PREV" stable

# Repeat per affected package. Most regressions hit 1–2; the bulk-release
# changesets keep version bumps in lock-step.
```

**DO NOT** run `npm unpublish` (72-hour window, disallowed with downstream
installs, breaks consumers). **DO NOT** run `pnpm changeset publish`
manually (#669: bypasses `workspace:` rewriting, will leak workspace deps).

After rollback, author a hotfix changeset on `develop`, run the same
release procedure for the next `develop → main` cut. The next publish will
move `@stable` forward to the hotfix version.

## Troubleshooting

### Version PR's diff includes unrelated changes

The pinned SHA must be the only thing changing on `main`. If the Version
PR shows extra changes:

1. Operational freeze was broken — another commit landed on `develop` and
   was merged to `main` before the Version PR opened.
2. Close the Version PR.
3. Re-pin a new `develop` SHA, re-merge, let the workflow open a fresh
   Version PR.

### `Verify no workspace protocol leaks in packed tarballs` fails

A package's published tarball would contain a `workspace:` literal — a
regression of the #669 root cause. DO NOT merge a workaround or hand-edit
the tarball. Investigate the package's `dependencies` block on the pinned
SHA; fix forward on `develop` and re-cut.

### `npm view @generacy-ai/control-plane@stable version` still shows 0.3.0

Either the publish step skipped (all packages were already at their
post-bump versions — unexpected here since we just bumped them) or the
publish step failed silently. Check the workflow log; re-run the publish
job.

### Live cluster never connects

Unrelated to this release — check the device-code flow, ensure
`generacy launch` is using the activation URL, and consult
`generacy doctor`. This is not a release-cut blocker; the release is
considered successful if SC-002 passes and SC-003 can be retried against
a freshly-pulled image.

## Reference

- Trigger contract: `contracts/release-workflow.md`
- Why this workflow, not `pnpm changeset publish`: generacy-ai/generacy#669
- Why live verification, not just tarball: generacy-ai/generacy#746
- Why we ship `feat-750-…` in this cut: spec.md §Assumptions, Q1=A
- Rollback via `npm dist-tag`: Q5=B
