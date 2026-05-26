# Quickstart: Changeset Check

**Feature**: #720 — Make Changeset Bot a Required, Blocking Check

## For PR authors

### "I changed code in `packages/*/src/` — what do I do?"

Run from repo root:

```bash
pnpm changeset
```

Walk through the interactive prompt:
1. Select which packages your change affects (space to toggle, enter to confirm).
2. Pick the bump type per package — `patch`, `minor`, or `major`.
3. Write a one-line summary (this lands in the next CHANGELOG entry).

Commit the generated `.changeset/<random-name>.md` file alongside your code change and push. The check turns green.

### "My change shouldn't bump a version" (typo fix, refactor with no public-API change, etc.)

```bash
pnpm changeset --empty
```

This generates an empty changeset, satisfies the check, and is consumed without bumping versions when releases are cut. Use sparingly — if in doubt, prefer a `patch` bump.

### "I only changed test files"

No action needed. Test-only PRs (every in-scope file matches `*.test.ts(x)`, `*.spec.ts(x)`, or is under `/__tests__/`) skip the check automatically. The CI log will say:
```
Only test files changed under packages/*/src/; skipping changeset check.
```

### "I only changed docs / specs / CI / repo config"

No action needed. PRs that don't touch `packages/*/src/` skip the check. CI log:
```
No publishable-package source files changed; skipping changeset check.
```

### "The check failed — what now?"

The error message tells you the rule:
```
::error::This PR modifies packages/*/src/ but adds no changeset.
Run `pnpm changeset` from the repo root to add one before merging.
```

If you genuinely shipped no consumer-facing change, use `pnpm changeset --empty` (above). Otherwise: `pnpm changeset`, commit, push.

## For maintainers (rollout)

### One-time, post-merge

After this PR lands on `develop`, go to **Settings → Branches** in the generacy repo and update both branch-protection rules:

1. **`develop`** rule:
   - Under "Require status checks to pass before merging", search for and add: `Changeset Bot / Changeset Check`.
   - Save.

2. **`main`** rule:
   - Same: add `Changeset Bot / Changeset Check` to the required checks list.
   - Save.

**Important**: do not add the required check before this PR is merged. The check name only becomes resolvable once the workflow has run at least once on the target branch; adding it preemptively will block every open PR with "expected check missing".

### Verifying the rollout

After enabling the required check, open a tiny test PR (any non-source change, e.g. a typo in `README.md`) and confirm the check appears in the PR checks list and passes. Then close it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Check blocks a PR that only deletes a `src/` file | `git diff` reports the deletion as a change under `packages/*/src/`; the new check treats deletions as in-scope. | Add a changeset (a deletion of a public-API file is a `minor` or `major` change anyway). |
| Check blocks a `develop → main` sync PR | The sync PR didn't include the original feature branches' changesets. | Re-cut the sync from `develop` ensuring `.changeset/*.md` files are present. |
| Check appears red on a draft PR | Shouldn't happen — `if: draft == false` skips drafts. | Re-check the job's `if:` guard wasn't accidentally removed. |
| `git diff` errors with "bad object" | `fetch-depth: 0` was removed from `actions/checkout`. | Restore `fetch-depth: 0`. |
| Check name doesn't appear in branch-protection search | Workflow hasn't run yet on the target branch. | Merge the workflow PR first; check will become selectable after it executes. |
| `changeset-release/main` (bot) PR fails the check | The bot PR shouldn't touch `packages/*/src/`; if it does, that's a release-tooling regression. | Investigate the changesets-release action; do not exempt the bot. |
