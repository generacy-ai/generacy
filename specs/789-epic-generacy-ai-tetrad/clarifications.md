# Clarifications

## Batch 1 — 2026-06-26

### Q1: Engine API surface for PR resolution & merge
**Context**: FR-002, FR-006, and SC-005 require both verbs to go through the `@generacy-ai/cockpit` engine ("0 direct `gh` calls outside engine layer"). The engine currently exposes only `listIssues`, `addLabels`, `removeLabels`, and `getPullRequestCheckRuns` (`packages/cockpit/src/gh/wrapper.ts`). There is no `resolveIssueToPR()`, no `mergePullRequest()`, and no PR-diff/metadata API. Without resolving this, the verbs cannot meet both FR-002/FR-006 and SC-005 simultaneously.
**Question**: Where do the missing engine capabilities (issue→PR resolution, squash-merge, PR diff/metadata) land?
**Options**:
- A: Extend `GhCliWrapper`/`GhWrapper` in this PR with `resolveIssueToPR(repo, issue)`, `mergePullRequest(repo, prNumber, {squash})`, and a `getPullRequest(repo, prNumber)` (metadata+diff) — keep SC-005 intact.
- B: Allow the CLI verbs to shell out to `gh pr view/diff/merge` directly; relax SC-005 to "no duplicated checks logic" only.
- C: Hybrid — add `resolveIssueToPR()` and `getPullRequest()` to the engine, but `mergePullRequest()` shells out directly from the verb (treating mutating ops differently from reads).

**Answer**: *Pending*

### Q2: Failing-check JSON schema
**Context**: FR-005 / SC-003 require a "stable JSON schema" on stdout when `merge` exits non-zero, but the exact shape is unspecified. Downstream automation needs to parse this deterministically.
**Question**: What is the top-level shape of the failing-check JSON?
**Options**:
- A: Object wrapper: `{ status: "red", reason: "checks-failing"|"missing-label"|"unresolved", pr: { number, url }, failingChecks: [{ name, state, url? }] }` — includes PR identifiers and a discriminator for non-check red causes (e.g., label missing).
- B: Minimal object: `{ failingChecks: [{ name, state, url? }] }` — only the check list, no PR or status metadata.
- C: Bare array of checks: `[{ name, state, url? }]` — most compact, but no room to express non-check red causes (e.g., label missing) in the same shape.

**Answer**: *Pending*

### Q3: What "required" means for checks
**Context**: FR-004 treats "failure, pending, missing required" as red. The definition of "required" is undefined — GitHub has branch-protection required checks, and PRs also have their own check runs. "Missing" only makes sense if there is an authoritative list of expected checks.
**Question**: How is the set of required checks determined?
**Options**:
- A: Query `develop`'s branch protection (e.g., `gh api repos/{owner}/{repo}/branches/develop/protection`); "missing" = a protected check not present on the PR.
- B: All checks present on the PR are treated as required; "missing" is not a separately detectable state — only `FAILURE`/`PENDING` cause red.
- C: Configurable list under `.generacy/cockpit.yaml` (or similar); defaults to option B if unset.

**Answer**: *Pending*

### Q4: Behavior on pending checks
**Context**: FR-004 calls pending checks red, but does not say whether the verb should wait for them to resolve. Behavior here changes whether `cockpit merge` is fail-fast or long-running.
**Question**: When checks are pending/in-progress/queued, does `cockpit merge` wait or exit red immediately?
**Options**:
- A: Exit red immediately on any non-success — strictly fail-fast, no polling.
- B: Poll for a bounded time (e.g., 5 min, configurable via `--wait` flag) before declaring red.
- C: Fail-fast in this scope (option A); add `cockpit wait <issue>` as a follow-up verb in a later issue.

**Answer**: *Pending*

### Q5: `review-context` payload shape & required fields
**Context**: FR-009 / SC-004 require a "structured payload" with "PR metadata, diff, and check results" but do not specify format or exhaustive field list. The review skill is the consumer (out of scope here) so the contract needs to be pinned down now.
**Question**: What is the on-stdout format and required field set for `cockpit review-context <issue>`?
**Options**:
- A: Single JSON object `{ pr: { number, title, url, base, head, body, author, state, draft }, diff: "<unified diff text>", checks: [{ name, state, conclusion?, url? }] }` — diff as a single text blob.
- B: Same as A but `diff` is a structured per-file array: `files: [{ path, status, additions, deletions, patch }]` instead of a text blob.
- C: Same as A plus optional fields: `reviewComments: [...]`, `commits: [...]`, `labels: [...]` — broader payload now, even though only diff+checks are explicitly required.

**Answer**: *Pending*
