# Quickstart: `cockpit merge` reads `completed:validate` from the issue (#853)

## What changed for operators

Before the fix, `generacy cockpit merge <owner/repo#N>` checked the linked **PR's** labels for `completed:validate`. But the label protocol writes that label on the **issue** — nothing syncs it to the PR. Result: `cockpit merge` always returned `{"status":"red","reason":"missing-label"}` on real epics, and worked only in unit tests that pre-labeled the PR fixture.

**After the fix**, `cockpit merge`:

1. Reads `completed:validate` from the **issue's** labels (matching the orchestrator's write path).
2. Refuses to merge when the linked **issue** is `CLOSED` — including "closed as duplicate", "closed as not planned", or "closed as completed by an unrelated PR". The operator override is `gh issue reopen <ref>`.
3. Every red payload now additively carries an `issue: {owner, repo, number}` field alongside the existing `pr` field, so diagnostic output names both refs.

## Verifying the fix locally

The live repro target is `christrudelpw/sniplink#2` (linked PR `#16`), which has:

- Issue `#2` carrying `completed:validate` (workflow already ran).
- PR `#16` OPEN, checks green.

```bash
# On the fixed CLI:
generacy cockpit merge christrudelpw/sniplink#2

# Expected before fix: {"status":"red","reason":"missing-label"} (bug)
# Expected after fix:  exit 0, empty stdout, PR merged as squash to develop
```

To verify the `missing-label` branch now names the issue:

```bash
# Pick an epic whose issue has NO `completed:validate` label:
generacy cockpit merge <owner>/<repo>#<n>

# Expected stdout:
# {"status":"red","reason":"missing-label",
#  "pr":{"number":42,"url":"https://github.com/o/r/pull/42"},
#  "issue":{"owner":"o","repo":"r","number":<n>},
#  "failingChecks":[]}
```

To verify the CLOSED-issue guard:

```bash
# Close an OPEN test issue whose PR is still OPEN with green checks:
gh issue close <owner>/<repo>#<n> --reason completed
generacy cockpit merge <owner>/<repo>#<n>

# Expected stdout:
# {"status":"red","reason":"unresolved",
#  "pr":{"number":42,"url":"..."},
#  "issue":{"owner":"o","repo":"r","number":<n>,"state":"CLOSED","stateReason":"completed"},
#  "failingChecks":[]}

# The deliberate override:
gh issue reopen <owner>/<repo>#<n>
generacy cockpit merge <owner>/<repo>#<n>   # merges normally
```

## Rolling back a stranded operator workaround

If you applied the interim workaround from the smoke-test finding (`gh pr edit <pr> --add-label completed:validate`), remove it after installing the fixed CLI. The label was ignored by the fixed code path; leaving it on the PR is harmless but misleading:

```bash
gh pr edit <owner>/<repo>#<pr-number> --remove-label completed:validate
```

The label on the **issue** is the source of truth and stays untouched.

## Running the tests

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/merge.test.ts
```

Expected: all pass, including the four new regression cases:

- `FR-007a`: issue-labeled + PR-unlabeled → merge succeeds (counterexample fixture; this is the test that would have caught #853).
- `FR-007b`: issue-unlabeled → `missing-label` with the ISSUE ref in the payload.
- `FR-007c`: CLOSED issue → red with `issue.state`/`issue.stateReason`; `mergePullRequest` never called.
- `SC-004 meta-test`: no fixture in `merge.test.ts` sets `labels: ['completed:validate']` on a `PullRequestDetail` (the tests-encode-the-bug guard).

## Output changes (payload)

**Before** (any red outcome):
```json
{"status":"red","reason":"missing-label","pr":{"number":42,"url":"..."},"failingChecks":[]}
```

**After** (any red outcome from `runMerge`):
```json
{"status":"red","reason":"missing-label","pr":{"number":42,"url":"..."},"issue":{"owner":"o","repo":"r","number":7},"failingChecks":[]}
```

CLOSED-issue red branch additionally carries `state` and `stateReason` on the `issue` object.

## `IssueStateResult` extension (developer-facing)

If you consume `@generacy-ai/cockpit`'s `fetchIssueState(repo, issue)`, the returned object now includes:

```ts
{
  state:       'OPEN' | 'CLOSED',
  stateReason: string | null,           // ← NEW; null when gh returns no state_reason
  closedAt:    string | null,
  labels:      string[],
  assignees:   string[],
  title:       string,
}
```

Existing callers that ignore `stateReason` continue to work.

## Troubleshooting

**Symptom**: `cockpit merge` still returns `missing-label` on a fresh epic even after installing the fix.
- **Check**: `gh issue view <owner>/<repo>#<n> --json labels`. If `completed:validate` is not on the issue, the workflow's validate phase never completed — the merge gate is doing its job. Re-run validate, or check orchestrator logs for a missed `completed:validate` write.
- **Check**: `generacy --version`. Confirm the running CLI includes the #853 fix (post-2026-07-08).

**Symptom**: `cockpit merge` returns `unresolved` with `pr: null` and a raw `gh` error in stderr, but the issue exists.
- **Check**: run `gh issue view <owner>/<repo>#<n> --json state,stateReason,closedAt,labels,assignees,title` — the exact call `runMerge` makes. If it fails, that's the underlying gh problem (network, auth, repo permissions, malformed JSON). The `unresolved` payload is the expected surface (Q2→B).
- **Fix**: address the gh CLI failure (auth token, network, or gh version); rerun.

**Symptom**: `cockpit merge` returns `unresolved` with `issue.state: 'CLOSED'` — but the operator wants to merge anyway.
- **Check**: is the CLOSED-as-completed-by-another-PR an actual duplicate (safe to keep closed), or a false close (needs to reopen)?
- **Fix (deliberate override, Q3→A rationale)**: `gh issue reopen <owner>/<repo>#<n>` then rerun `cockpit merge`. No CLI `--force` flag is provided.

**Symptom**: `IssueStateResult.stateReason` is always `null` even on issues closed with a reason.
- **Check**: `gh --version`. `stateReason` requires gh CLI ≥ v2.24 (Feb 2023). Cluster-base pins ≥ v2.40.
- **Fix**: upgrade the gh CLI on the operator workstation or in the container image.
