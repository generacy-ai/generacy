# Quickstart: verify `cockpit merge` head-branch deletion

**Issue**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Prerequisites

- Node.js ≥22
- `gh` CLI 2.96.x+ (`gh --version`)
- `pnpm install` at repo root
- `gh auth login` with a token that has `repo` scope (delete-ref requires push permission on the head repo)

## Build

```bash
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

## Run tests

```bash
# Wrapper primitive tests (deleteHeadRef + headRepositoryOwner)
pnpm --filter @generacy-ai/cockpit test -- gh-wrapper.test

# Consumer decision-tree tests (four deletion outcomes)
pnpm --filter @generacy-ai/generacy test -- merge.test
```

Expected: all SC-101/102/103/104/105 assertions pass; existing SC-001..007 (green + completed:validate → merge) still pass.

## Manual verification against a live repo

### Case A — same-owner PR with auto-delete off (deleted)

**Setup**:
- Repo without `delete_branch_on_merge` enabled.
- Any open PR from a branch you can force-delete (e.g. a scratch branch).
- Issue has `completed:validate` label; PR has no failing required checks.

**Run**:
```bash
generacy cockpit merge <issue-number> --repo <owner>/<repo>
```

**Expected stdout**:
```
merged and branch deleted
```
(No leading vacuous-green note unless the repo has zero required checks.)

**Verify**: `gh api repos/<owner>/<repo>/git/refs/heads/<head-branch>` returns 404. GitHub's "Restore branch" button is available; the branch listing no longer shows the head.

### Case B — same-owner PR with auto-delete ON (already gone)

**Setup**: Repo with `delete_branch_on_merge: true`.

**Expected stdout**:
```
merged (branch was already deleted)
```

**Rationale**: GitHub's own auto-delete beat the explicit DELETE by a few ms; the ref returned HTTP 422 "Reference does not exist" on our call, which the wrapper classifies as `already-gone`.

### Case C — cross-fork PR (skipped)

**Setup**: PR opened from a fork owned by a different login than the base repo.

**Expected stdout**:
```
merged (branch delete skipped: cross-fork PR)
```

**Verify**: no `gh api -X DELETE` call was made (visible in `--verbose` logs if needed); `logger.info` fired with `{ headOwner: '<fork-owner>' }`.

### Case D — delete-failed (permission or transient)

**Setup**: token lacks push permission on the head repo (or gh returns 5xx during the DELETE — harder to reproduce; simulate with a revoked token if needed).

**Expected stdout**:
```
merged (branch delete failed: HTTP 403: Resource not accessible by integration)
```
(or whatever the specific gh stderr is)

**Verify**: `logger.warn` fired with the stderr in bindings; exit code is still 0 (`echo $?` → 0); the branch remains available for manual cleanup via GitHub UI.

### Case E — vacuous-green + deleted (composite path)

**Setup**: CI-less unprotected repo (the sniplink#16-shaped case). Issue has `completed:validate`; PR has no checks; no branch protection.

**Expected stdout**:
```
no checks configured and none required — proceeding on completed:validate
merged and branch deleted
```

**Rationale**: composes the #857 vacuous-green note with the #859 deletion suffix. Both fixes must land together for this repo class to work end-to-end.

## Live-repro closure

**Issue #859's driving regression** — christrudelpw/sniplink PR #16 (finding #24 of generacy-ai/tetrad-development#88):

Before this fix: `cockpit merge` succeeded (post-#857), but the head branch `002-phase-1-foundation-part` was left behind. GitHub's "branch can be safely deleted" prompt reappeared; the manual playbook's hygiene step came back into scope.

After this fix: the next successful cockpit squash-merge on that repo (or any successor sibling issue) prints `merged and branch deleted` (or, if the operator has since flipped `delete_branch_on_merge` on, `merged (branch was already deleted)`) and the head branch no longer appears in `gh api repos/christrudelpw/sniplink/branches`.

## Troubleshooting

- **stdout shows `merged (branch delete failed: HTTP 404: …)`** on what looks like a normal same-owner PR: the head ref name may have been URL-encoded incorrectly, or the repo lookup itself missed. Verify `gh api repos/<owner>/<repo>` returns 200 out-of-band; if so, this is a gh-side bug — file a follow-up.
- **stdout shows the `delete failed` variant on a repo where `gh api -X DELETE` succeeds by hand**: the wrapper's stderr regex `/HTTP\s+422|HTTP\s+404/` may not have matched a new gh error surface. Grep for the exact stderr string on the wrapper's non-throw path — if a new HTTP code needs adding, extend the regex.
- **`headRepositoryOwner` shows as `null` on a same-owner PR**: unlikely, but possible if gh's `--json headRepositoryOwner` output shape changed. Verify with `gh pr view <N> --repo <r> --json headRepositoryOwner --jq .`; if `.headRepositoryOwner.login` is present but the wrapper reads `null`, the raw schema needs updating.
- **Test `SC-101` fails with byte diff on stdout**: the canonical string is `merged and branch deleted\n`. Ensure the trailing `\n` is present and the surrounding whitespace is exact.

## Rollback

Revert the following files in this order:

1. `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` (drop SC-101..105).
2. `packages/generacy/src/cli/commands/cockpit/merge.ts` (drop helper + two call sites).
3. `packages/cockpit/src/__tests__/gh-wrapper.test.ts` (drop `deleteHeadRef` + `headRepositoryOwner` tests).
4. `packages/cockpit/src/gh/wrapper.ts` (drop `deleteHeadRef` method, `DeleteHeadRefResult`, `PullRequestDetail.headRepositoryOwner`, raw-schema field, JSON list expansion).

No data migration; no relay-payload change; no coordinated cross-repo work. Rollback restores finding #24's residual-branch behavior.
