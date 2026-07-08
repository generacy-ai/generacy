# Clarifications — #853

## Batch 1 — 2026-07-08

### Q1: Order of the issue-label check vs. PR resolution (FR-001, FR-002)
**Context**: Today `runMerge` (`packages/generacy/src/cli/commands/cockpit/merge.ts:26`) resolves the PR first (`resolveIssueToPRRef` → OPEN check → `getPullRequestDetail`) and *then* reads `pr.labels`. After the fix, the label lives on the issue — which the CLI has in hand from `resolveIssueContext` before any gh call. This unlocks a fail-fast path (check the issue label *before* PR resolution), but it collides with the `buildFailingCheckPayload` invariant that `missing-label` requires a non-null `pr` (`shared/failing-check-json.ts:32-44`). Where the check lives dictates whether that invariant survives and whether the `missing-label` payload carries a PR ref, only an issue ref, or both.

**Question**: Where should the issue-label check happen relative to PR resolution?
**Options**:
- A: **Before PR resolution.** Fail-fast: if the issue lacks `completed:validate`, return `missing-label` without ever calling `resolveIssueToPRRef`/`getPullRequestDetail`. The `missing-label` payload's `pr` field becomes `null` (invariant relaxed to match `unresolved`) and the issue ref is the sole identifier.
- B: **After PR resolution (current order).** Keep resolving the PR first, then read the *issue's* labels. `missing-label` payload keeps its non-null `pr` invariant and additively gains an issue ref field — operators see both refs.
- C: **In parallel with PR resolution** (`Promise.all([fetchIssueLabels, resolveIssueToPRRef → getPullRequestDetail])`). Missing-label payload optionally includes PR ref when the parallel resolution happened to succeed, `null` otherwise.
- D: Other (please specify).

**Answer**: *Pending*

---

### Q2: Behavior when the issue-label fetch itself fails
**Context**: `GhWrapper.fetchIssueLabels`/`getIssue` will throw on: issue not found (404), repo mismatch, gh CLI network/auth failure, or malformed JSON (`packages/cockpit/src/gh/wrapper.ts:883-909`). The spec (FR-001, FR-002, SC-002) covers the "issue exists but is unlabeled" branch; it does not name the failure mode. Currently `runMerge` has no try/catch around `getPullRequestDetail` either — an exception bubbles as an uncaught process crash (non-JSON exit). Whichever choice we make here also sets precedent for future gh-error paths in this verb.

**Question**: If the issue-label fetch throws, what should `runMerge` return?
**Options**:
- A: **New red reason** — extend `RedReason` with `'issue-fetch-failed'` (or `'unresolved-issue'`), emit the `failing-check` JSON with that reason and an issue ref, exit 1. Keeps the CLI contract "either exit 0 or emit red JSON."
- B: **Reuse `unresolved`** — the current `unresolved` reason already models "we couldn't get far enough to check." Emit `{status:"red", reason:"unresolved", pr:null}` and additively include an issue ref field.
- C: **Let the exception bubble** — non-zero exit, no red JSON, stderr carries the gh error. Matches today's behavior for other gh failures inside `runMerge` (which also don't try/catch).
- D: Other (please specify).

**Answer**: *Pending*

---

### Q3: Is issue state (OPEN/CLOSED) a merge blocker?
**Context**: `runMerge` currently blocks merge when `prRef.state !== 'OPEN'` (`merge.ts:39-53`). No equivalent guard exists for the issue. In practice, an issue can be closed (e.g., manually, or by an unrelated PR mentioning `closes #N`) while still carrying `completed:validate` and having an open PR whose checks are green — should `cockpit merge` still squash-merge? The spec's Out-of-Scope bullets don't cover this, and it's a real edge case for the tetrad-development#88 smoke pattern (closed-then-reopened issues, or issues closed as duplicates while their PR stays live).

**Question**: Should `runMerge` refuse to merge when the issue is closed?
**Options**:
- A: **Yes, mirror the PR-state check** — if the issue is `CLOSED`, return `{status:"red", reason:"unresolved", pr:{...}}` (or a new `issue-closed` reason) with the issue ref. Symmetric with the existing PR-OPEN guard.
- B: **No, ignore issue state entirely** — the `completed:validate` label is the sole issue-side gate. Closed issues with the label + green checks still merge.
- C: **Only block on issues closed *not-as-completed*** — if the issue is closed with `state_reason: 'not_planned'` (or similar), block; otherwise proceed. GraphQL/gh CLI surface this via `stateReason`.
- D: Other (please specify).

**Answer**: *Pending*
