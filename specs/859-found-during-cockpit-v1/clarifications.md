# Clarifications: `cockpit merge` deletes the head branch after squash

**Issue**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Batch 1 — 2026-07-08

### Q1: Delete mechanism
**Context**: FR-001 permits either flipping `mergePullRequest`'s `--delete-branch=false` → `--delete-branch` (single `gh pr merge` call), OR keeping `--delete-branch=false` and issuing an explicit `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/{head}` after merge confirmation. The two approaches have different error semantics — `gh pr merge --delete-branch` may silently succeed on repos with auto-delete on (making FR-003's "already deleted" case invisible), while the explicit ref delete gives a distinct 422/404 the caller can classify. This choice cascades into stdout wording, test mocks, and how FR-003 vs FR-004 are distinguished.
**Question**: Which delete mechanism should the implementation use?
**Options**:
- A: `gh pr merge --delete-branch` (single call, gh handles delete + already-gone case internally, less classification power)
- B: Explicit `gh api -X DELETE …/git/refs/heads/…` after `gh pr merge` succeeds (two-step, sharpest FR-003/FR-004 distinction, larger diff)
- C: Explicit ref delete as the default; use single-call `--delete-branch` only if simpler tests pass equivalence checks

**Answer**: *Pending*

### Q2: Cross-fork detection source
**Context**: FR-004 requires skipping the delete for cross-fork PRs with an info log. The spec suggests detection via `PullRequestDetail`: head repo owner ≠ base repo owner, OR the `gh` error message clearly indicates permission denial. But `PullRequestDetail` today carries only ref names (`base`, `head`), not repo owners — a small wrapper extension would be needed to surface `headRepositoryOwner`. Relying on `gh` stderr pattern-matching for permission denial is fragile (message wording changes across `gh` versions).
**Question**: How should cross-fork PRs be detected?
**Options**:
- A: Extend `PullRequestDetail`/`getPullRequestDetail` to surface `headRepositoryOwner` (or a boolean `isCrossFork`); classify pre-delete deterministically; treat any permission-shaped `gh` error afterwards as an FR-005 warn.
- B: Do not extend the wrapper; attempt the delete unconditionally and pattern-match `gh` stderr for permission-denial keywords (`must have admin`, `403`, `Resource not accessible`) to route to FR-004; everything else routes to FR-005.
- C: Both — surface `headRepositoryOwner` for the deterministic pre-check, but also treat permission-shaped `gh` errors as FR-004 as a safety net.

**Answer**: *Pending*

### Q3: Wrapper vs caller — where does the delete step live?
**Context**: `mergePullRequest` (wrapper.ts:799) is the natural place to attach delete-branch behavior (it already knows `repo`, has the `runner`, and returns `MergeResult`). But `runMerge` (merge.ts) owns the operator-facing stdout composition and the two success-path branches. Options differ in mockability, `MergeResult` API surface, and which layer owns fork classification.
**Question**: Where should the delete logic live?
**Options**:
- A: Inside `mergePullRequest` — extend `MergeResult` with `branchDeletion: 'deleted' | 'already-gone' | 'skipped-cross-fork' | 'delete-failed'` (plus optional stderr for the last case); `runMerge` reads that field to compose stdout. Wrapper carries fork-detection.
- B: In `runMerge` — keep `mergePullRequest` unchanged (still passes `--delete-branch=false`); `runMerge` calls a new `deleteHeadRef(repo, headRef)` wrapper method after merge succeeds, classifies outcomes there, composes stdout there. Caller carries fork-detection.
- C: Split — wrapper exposes primitives (`mergePullRequest`, `deleteHeadRef`, and a fork-check helper such as `isCrossForkPr(detail)`); `runMerge` orchestrates.

**Answer**: *Pending*

### Q4: Exact stdout wording
**Context**: FR-002/FR-003/FR-004 give example strings ("merged and branch deleted", "merged (branch was already deleted)"). SC-004's regression test likely asserts on stdout. Locking wording avoids test churn and lets downstream consumers grep; leaving it flexible allows the implementer to refine phrasing. The vacuous-green path already emits `"no checks configured and none required — proceeding on completed:validate\n"` and needs an append; the classify-passing path emits `''` today and needs a new base message.
**Question**: Are the stdout strings from FR-002 through FR-005 exact canonical strings, or wording suggestions?
**Options**:
- A: Canonical — implement exactly: `merged and branch deleted`, `merged (branch was already deleted)`, `merged (branch delete skipped: cross-fork PR)`, `merged (branch delete failed: <gh stderr>)`; on the vacuous-green path append after the existing line; on the classify-passing path emit as the sole stdout line. Tests assert on these strings.
- B: Flexible — implementer chooses precise phrasing; tests assert on substring markers (`deleted`, `already deleted`, `cross-fork`, `delete failed`).
- C: Canonical for the four success/skip variants; flexible for the FR-005 warning line since it wraps arbitrary gh stderr.

**Answer**: *Pending*

### Q5: Operator opt-out
**Context**: The spec makes deletion the default post-merge behavior and out-of-scopes flipping the repo-level auto-delete setting. It does not address whether the operator should have a per-invocation opt-out (e.g., `--keep-branch`) — useful when merging a PR whose head branch is still being used for follow-up review or when GitHub's UI-side branch delete is preferred. Adding a flag now costs one option and one test; adding later is a breaking-behavior surprise.
**Question**: Should `cockpit merge` support an operator opt-out for the delete step?
**Options**:
- A: No — deletion is unconditional on merge success (spec as written); operator uses `gh pr merge` directly if they want the old behavior.
- B: Yes — add `--keep-branch` (or `--no-delete-branch`) flag that skips the delete step; success stdout in that case says `merged (branch delete skipped: --keep-branch)`.
- C: Defer — ship without a flag; add one only if operators actually request it after the change lands.

**Answer**: *Pending*
