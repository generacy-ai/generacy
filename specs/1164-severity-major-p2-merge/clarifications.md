# Clarifications

## Batch 2026-08-21

### Q1: Stale scope — clear vs. extend (Defect 1, FR-001/FR-002)
**Context**: `reviewScope` is a `{baseSha, headSha}` pair threaded from the merge-conflict re-arm into `context.reviewScope` and is never cleared. On the remediate→review backtrack the same context object is reused, so the re-review stays pinned to the pre-remediation window and the fix commits are invisible. FR-001 explicitly allows either "cleared" or "extended". These produce materially different re-review surfaces and different code.
**Question**: When remediation commits are pushed after a scoped review returns `changes-required`, how should the subsequent re-review be scoped?
**Options**:
- A: Clear the scope after the first scoped round — the re-review falls back to the standard #1126 delta (from the prior artifact's `lastReviewedCommitSha` to current HEAD), which naturally includes the remediation commits.
- B: Extend the scope by advancing `headSha` to current HEAD (keeping the original `baseSha`), so the window grows to include the remediation commits while still excluding the rest of the PR.
- C: Other (specify).

**Answer**: A — Clear the scope after the first scoped round; fall back to the standard #1126 delta (`lastReviewedCommitSha`..HEAD), which naturally includes the remediation commits. Rationale: the executor already runs the delta machinery keyed on the prior artifact's `lastReviewedCommitSha`, so clearing lets the delta span `lastReviewedCommitSha`..HEAD for free; extending `headSha` (keeping `baseSha`) keeps the full parent-1 base delta pinned every round, re-introducing Defect 2 that FR-003 exists to eliminate.

### Q2: Conflict-resolution surface signal (Defect 2, FR-003)
**Context**: The scope's `baseSha` is `HEAD^1` (pre-merge branch tip) and `headSha` is the merge commit, so `baseSha..headSha` is the full parent-1 diff — it contains *all* base-branch changes merged in, not just the resolution. A two-SHA range alone cannot exclude base-only changes; the fix needs a different diff basis or an explicit path filter. This changes what `getResolutionScope` computes and possibly the `ReviewScope` shape.
**Question**: What signal should define the "conflict-resolution surface" that the scoped review inspects?
**Options**:
- A: Capture the set of conflicted file paths at resolution time (e.g. `git diff --name-only --diff-filter=U` on the failed merge) and pass them as an explicit path allowlist the reviewer/charter is restricted to.
- B: Change the diff basis to merge-base three-dot semantics (`git diff --merge-base <base> HEAD` or an equivalent that excludes changes already on the base branch).
- C: Other (specify).

**Answer**: A — Capture the conflicted file paths at resolution time (`git diff --name-only --diff-filter=U`) and pass them as an explicit path allowlist the scoped review is restricted to. Rationale: the conflicted paths are already enumerated at resolution time and already flow through evidence as `mergeConflict.conflictedPaths`, so an allowlist reuses captured data and confines the review precisely to the resolution surface; merge-base three-dot still pulls in the branch's entire own PR diff — the whole-PR review Defect 2 exists to avoid.

### Q3: Forcing `validate` on the post-merge tree (Defect 4, FR-006/FR-007)
**Context**: With `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a post-resolution `continue` resolves to `validate`, but the #1133 terminal short-circuit sees pre-existing `completed:validate` + `completed:implementation-review` labels and marks the PR ready without `validate` ever running on the merged tree. FR-007 frames this as "labels granted before the tree changed", implying tree-awareness; a simpler fix is to invalidate the label(s) on re-arm.
**Question**: How should the fix guarantee `validate` runs against the post-merge tree before mark-ready?
**Options**:
- A: Clear the `completed:validate` (and, if needed, `completed:implementation-review`) label(s) during the post-resolution re-arm, so the terminal short-circuit no longer fires and `validate` runs normally.
- B: Make the terminal short-circuit tree-aware — record the SHA `validate` last ran against and re-run `validate` (ignore the `completed:*` labels) whenever current HEAD differs.
- C: Other (specify).

**Answer**: A — Clear the `completed:validate` (and, if needed, `completed:implementation-review`) label(s) during the post-resolution re-arm so the terminal short-circuit no longer fires and `validate` runs against the post-merge tree. Rationale: the #1133 short-circuit keys purely on label presence and no validate-tree-SHA state exists today, so making it tree-aware requires net-new persisted state against the spec's "existing machinery / no new label vocabulary" assumption; the re-arm already edits labels, making label-invalidation the minimal in-machinery fix.

### Q4: Crash-window remediation (Defect 4, FR-008)
**Context**: `applySuccessDisposition` clears ownership labels (`agent:*`) before the re-arm item is enqueued. A crash in that window leaves the issue with no ownership label and no queued work — silently stalled. FR-008 wants ordering/idempotency so an interrupted re-arm converges on retry.
**Question**: How should the re-arm be made crash-safe?
**Options**:
- A: Reorder — enqueue the re-arm item before clearing the ownership labels (so a crash leaves queued work, not a stall).
- B: Keep current order but make recovery idempotent — a durable marker / re-arm intent that a monitor detects and re-enqueues after a crash.
- C: Other (specify).

**Answer**: A — Reorder: enqueue the re-arm item before clearing the ownership (`agent:*`) labels. Rationale: enqueuing first makes the crash-safe direction "queued work with a stale ownership label" (benign, overwritten by `onResumeStart`) rather than "no label and no work" (silent stall); a durable-marker + recovery-monitor approach adds a new component heavier than this P2 note warrants and against the spec's minimalism.
