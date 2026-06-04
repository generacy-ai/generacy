# Research: `@generacy-ai/*@stable` release of pending changesets

## Decisions

### D1. Scope: drain all 16 in one cut (Q1=A)

**Decision**: Consume every `.md` in `.changeset/` (16 files, excluding
`README.md` / `config.json`) in a single `stable` cut. That includes
`feat-750-identity-split-detector.md`, which landed after the spec was
authored.

**Rationale**: `changeset version` drains everything pending — pulling one
out (Q1=B/C) means moving the file out of `.changeset/` temporarily, running
the release, and restoring it. That's needless friction for a changeset
that has already been staging-verified end-to-end (per the spec's
Assumptions). One clean drain.

**Alternatives considered**:
- Defer `feat-750-…` to a follow-up release (Q1=B): doubles the
  release-engineering cost (two `develop → main` cuts, two Version PR
  reviews) with no risk reduction.
- Temporarily move `feat-750-…` out of `.changeset/` (Q1=C): same outcome
  as B but with a manual file-move that's easy to forget to reverse.

### D2. Execution path: `.github/workflows/release.yml` (Q2=A)

**Decision**: Drive the release end-to-end via the existing
`.github/workflows/release.yml`. Triggered by `push: main`. The workflow
self-bifurcates:

- **Version mode** (pending changesets present): uses
  `changesets/action@v1` to run `pnpm changeset version` and open a "chore:
  version packages" PR. No publish.
- **Publish mode** (no pending changesets — the Version PR has merged):
  runs `verify-pack-no-workspace-deps.js`, then `pnpm -r --filter
  '!generacy-extension' publish --tag stable --no-git-checks --provenance`,
  then advances `@latest` per package, then triggers the devcontainer-feature
  publish workflow.

**Rationale**: The workflow is purpose-built and already handles every
known pitfall:

- Splits version and publish into two `main`-triggered runs (gated by
  `Determine workflow mode`).
- Uses `pnpm -r publish` instead of `pnpm changeset publish` — the latter
  shells to `npm publish` which doesn't rewrite `workspace:` deps and was
  the root cause of #669.
- Gates publish on `verify-pack-no-workspace-deps.js`, which packs every
  non-private workspace package and fails if any tarball still contains
  `workspace:` literals — the post-#669 belt-and-suspenders.
- Publishes with `--provenance` (which builds OIDC-attested provenance —
  the `id-token: write` permission is already set).
- Advances `@latest` per package after publish (idempotent dist-tag op).

**Alternatives considered**:
- Manual local: `pnpm changeset version` → PR → merge → `pnpm -r publish`
  from a clean checkout (Q2=B): runs under the operator's npm token (no
  audit trail), skips the OIDC-provenance flag, and requires the operator
  to remember the exact filter args. Higher operator burden, lower audit
  quality.
- Hybrid: version locally, publish via workflow (Q2=C): adds a manual step
  where automation already exists, with no compensating benefit.

### D3. Release scope = pinned `develop` SHA, operational freeze (Q3=B)

**Decision**: The release scope is the `develop` SHA that gets merged to
`main` at the start of the procedure. Between that merge and the Version PR
merge, hold further merges to `develop` and `main`. SC-002 verifies tarball
contents against that known SHA.

**Rationale**: The `main`-triggered workflow runs on whatever commit is on
`main`. If extra commits land on `develop` mid-release, they'd either pile
into the next `develop → main` merge (defeating the pin) or get cherry-picked
into the Version PR via rebase (introducing scope drift). An operational
freeze (a Slack/PR note saying "release in progress, hold merges") avoids
both. Cheaper than a release branch (Q3=C) because the workflow's
`concurrency` group + the single `develop → main` merge already serialize
everything.

**Alternatives considered**:
- `develop` HEAD at start of procedure with no freeze (Q3=A): permits
  late-arriving commits to slip into the Version PR; loses determinism of
  the pinned SHA.
- Short-lived release branch with code freeze (Q3=C): adds branch-management
  overhead for one merge. Workflow doesn't currently target a release branch,
  so we'd also need to change `on.push.branches`. Rejected as
  out-of-scope-overhead.

### D4. Verification: throwaway `stable` cluster (Q4=A)

**Decision**: After publish, `generacy launch`/`deploy` a disposable cluster
on the `stable` channel, confirm `vscodeTunnelName` matches
`^g-[0-9a-f]{18}$` in its relay metadata, then `generacy destroy`. Run this
SC-003 check in addition to SC-002's tarball inspection.

**Rationale**: This whole issue exists *because* tarball/static inspection
(#746) missed a real deploy-time mismatch. SC-002 catches "the function is
in the published tarball"; SC-003 catches "the function actually runs on a
real `stable`-channel deploy." Both are needed:

- Tarball inspection (SC-002) is fast and catches "publish skipped a
  package," "wrong file shipped," "build artifact didn't make it in."
- Live cluster (SC-003) is slower and catches "image wasn't rebuilt with
  the new package," "wrong image tag was pulled," "runtime wires a
  different code path than the package."

The throwaway cluster is the lowest-risk live test: it's `stable`-channel
(real surface), it's not a prod or staging cluster (no blast radius), and
it tears down cleanly.

**Alternatives considered**:
- Re-deploy or recreate an existing real prod cluster (Q4=B): production
  risk for a verification step. Also slower (real prod has more
  dependencies + monitoring noise).
- Flip staging from `preview` to `stable` for one boot, verify, flip back
  (Q4=C): pollutes the staging environment, leaves a dist-tag flip in the
  audit log that has nothing to do with the release.
- Tarball inspection only (Q4=D): explicitly rejected — repeats the #746
  failure mode.

### D5. Rollback path: `npm dist-tag` re-point (Q5=B)

**Decision**: If a regression surfaces post-publish, run
`npm dist-tag add @generacy-ai/<pkg>@<previous-good> stable` per affected
package to re-point `stable` back to the last-good version. Then author a
hotfix changeset and let the next `develop → main` cut ship the forward fix.

**Rationale**: `npm dist-tag` is instant (single API call per package),
non-destructive (the bad version stays in the registry — just not at
`stable`), and reversible (re-point forward when the hotfix ships). It's
the only post-publish rollback path that doesn't require waiting on a
hotfix or harming consumers.

**Alternatives considered**:
- Roll-forward only — no dist-tag move (Q5=A): leaves the bad version live
  as `@stable` until the hotfix ships. For a fix that requires a fresh
  changeset + Version PR + publish, that's at least 30 minutes of "prod is
  broken." Unacceptable.
- `npm unpublish` (Q5=C): only available within 72 hours, disallowed once
  packages have downstream installs (which they will, immediately after
  publish), and breaks any consumer that was already pulling the version.
  Footgun.
- Block release until rollback runbook is in spec (Q5=D): rollback runbook
  is now in `quickstart.md` (this artifact set); not a blocker on its own.

## Implementation Patterns

### The `release.yml` workflow's two-mode pattern

```text
push: main
   │
   ▼
Determine workflow mode
   │
   ├──pending changesets?──► version mode: changesets/action@v1 → Version PR
   │                                          ↓
   │                                       (operator reviews + merges Version PR)
   │                                          ↓
   │                                       push: main  (recurses)
   │
   └──no pending changesets──► publish mode: verify-pack → pnpm -r publish --tag stable
                                                              → dist-tag add @latest
                                                              → trigger devcontainer-feature publish
```

The same workflow runs on both pushes; the mode switch is data-driven on
the contents of `.changeset/`.

### Tarball-content verification (SC-002)

```bash
# 1. Resolve the latest published @stable tarball URL.
TARBALL=$(npm view @generacy-ai/control-plane@stable dist.tarball)

# 2. Download and inspect.
curl -sL "$TARBALL" | tar -xzO --wildcards 'package/dist/**/*.js' \
  | grep -q 'deriveTunnelName' \
  && echo "OK: deriveTunnelName present in @stable tarball" \
  || (echo "MISSING: deriveTunnelName NOT in @stable tarball"; exit 1)
```

### Live cluster verification (SC-003)

```bash
# 1. Launch a throwaway cluster on the stable channel.
generacy launch --channel stable --name release-verify-$(date +%s)

# 2. Inspect relay metadata. (vscodeTunnelName is published in metadata
#    via cluster-relay/src/metadata.ts; surfaced through /health and
#    `generacy status`.)
generacy status --json | jq -r '.vscodeTunnelName'
# Expected: g-<18 hex chars> (e.g., g-9e5c8a0d755e40b3b0)

# 3. Confirm shape.
echo "$NAME" | grep -E '^g-[0-9a-f]{18}$' \
  && echo "OK: UUID-derived tunnel name" \
  || (echo "FAIL: tunnel name not UUID-derived"; exit 1)

# 4. Tear down.
generacy destroy --yes
```

If `vscodeTunnelName` is missing from metadata, the cluster image was
likely not rebuilt against the new `@generacy-ai/control-plane@stable`. The
cluster-image build workflows
(`.github/workflows/publish-cluster-*-image.yml`) auto-detect new HEAD SHAs
on cluster-base / cluster-microservices and push `:stable` tags on
merges to `main` over there — but that's a separate repo and a separate
workflow. If the test cluster misses the fix, file a follow-up on the
cluster-image side; do NOT block this release.

### Rollback (Q5=B)

```bash
# Find the previous good version per package.
PREV=$(npm view @generacy-ai/control-plane versions --json \
  | jq -r '.[-2]')

# Re-point @stable.
npm dist-tag add @generacy-ai/control-plane@$PREV stable

# Repeat per affected package. Most regressions affect 1–2 packages;
# the bulk-release changesets keep version bumps in lock-step, so all
# packages move together, but rollback is per-package.
```

## Key Sources

- `.github/workflows/release.yml` (existing two-mode workflow).
- `scripts/verify-pack-no-workspace-deps.js` (publish gate post-#669).
- generacy-ai/generacy#669 (`changeset publish` workspace-deps bug).
- generacy-ai/generacy#744 (`deriveTunnelName` per-cluster identity).
- generacy-ai/generacy#746 (tarball inspection missed the real
  deploy-time mismatch — the motivating incident for SC-003).
- generacy-ai/generacy#749 (preview-side hardening; complementary, not a
  dependency).
- [changesets](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md):
  `changeset version` consumes `.md` files in `.changeset/`, bumps
  versions per package, writes per-package `CHANGELOG.md`.
- [npm dist-tag](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag):
  idempotent, instant, non-destructive — the rollback primitive for Q5=B.
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish):
  72-hour window, restricted with downstream installs — why Q5=C is
  rejected.
