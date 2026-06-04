# Quickstart: publish-preview hardening

## What changed

`.github/workflows/publish-preview.yml` now:

1. Resolves `origin/develop` HEAD at build time (closes the merge-race window).
2. Refuses to publish a candidate that is strictly behind the currently-published `@preview` tag.
3. Stamps every published `package.json` with the source SHA in two places.
4. Exposes a `force_rollback` input for deliberate backward publishes.

## Normal flow (no operator action)

A merge to `develop` automatically runs the workflow on the `push: develop` trigger and publishes a fresh `@preview`. No manual republish is needed.

## Verify what's deployed

```bash
# Which commit is the current @preview built from?
npm view @generacy-ai/generacy@preview version
# → 0.0.0-preview-20260604120000-abc1234

npm view @generacy-ai/generacy@preview gitHead
# → abc1234567890abcdef1234567890abcdef123456

# Does the current @preview contain commit X?
git merge-base --is-ancestor <X> $(npm view @generacy-ai/generacy@preview gitHead) \
  && echo "yes" || echo "no"
```

## Manual dispatch (advisory)

The race condition is closed by the build-time HEAD resolution, so manual dispatch is normally unnecessary. If you do dispatch manually:

```bash
# Normal manual republish (e.g., to retry a transient publish failure)
gh workflow run publish-preview.yml --ref develop

# Will succeed if develop HEAD is at or ahead of the current @preview gitHead.
# Will fail loudly if develop HEAD is behind (no silent stale publish).
```

## Incident rollback

When `@preview` ships a broken commit and you need to roll back staging to an earlier known-good SHA without merging a revert PR:

```bash
# Reset develop locally to the known-good commit (rare; usually use force-push to develop or a revert PR)
# Then trigger the workflow with force_rollback=true:
gh workflow run publish-preview.yml \
  --ref develop \
  -f force_rollback=true
```

The workflow logs an `WARNING: force_rollback=true` line identifying the backward publish as deliberate. The next `push: develop` event will publish whatever commit lands on `develop` next (the staleness guard reactivates automatically — `force_rollback` is per-run).

## Troubleshooting

### "STALE: candidate ... is an ancestor of current preview ..."

The workflow refused to publish a commit that is behind the current `@preview`. This is the guard working as intended.

- If a merge happened concurrently: the next `push: develop` event will publish the post-merge tip. Wait ~5 minutes and re-verify with `npm view @generacy-ai/generacy@preview gitHead`.
- If `develop` was force-pushed: confirm the force-push was intentional, then re-run with `force_rollback=true`.
- If this fires unexpectedly: check `git log <candidate-sha>..<current-sha>` to see what's "ahead." Typically means a merge landed between when you queued the dispatch and when the job started running.

### "No baseline gitHead for ... — publishing unconditionally"

First publish after this feature ships, or after a registry wipe, or for a new package. Expected; the publish establishes the baseline.

### Version no longer matches the old format

Old: `0.0.0-preview-20260604120000`
New: `0.0.0-preview-20260604120000-abc1234`

Consumers that resolve `@generacy-ai/*@preview` by dist-tag are unaffected. Consumers that hard-pin a specific snapshot version string will need to update — but hard-pinning a snapshot version is already an anti-pattern (use the dist-tag).

## Files

- `.github/workflows/publish-preview.yml` — workflow (modified)
- `scripts/stamp-source-sha.mjs` — writes `gitHead`, `generacy.sourceSha`, and `-<sha7>` suffix
- `scripts/check-preview-staleness.mjs` — runs `npm view` + `git merge-base --is-ancestor`, exits non-zero on stale

## Related

- #744 — `deriveTunnelName` race that motivated this work
- #746 — cloud-deployed cluster that received the stale preview
- #538 — original `push: develop` auto-publish enablement (FR-001 already satisfied)
