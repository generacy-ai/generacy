# Clarifications for #316 — Post Clarification Questions to Issue

## Batch 1 — 2026-03-05

### Q1: Redundancy with Existing Clarify-Phase Posting
**Context**: The clarify operation in `workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 268-305) already posts questions to the GitHub issue via `gh issue comment` during the clarify phase. The spec states questions are "never posted" — this contradicts what the code does.
**Question**: Is the existing clarify-phase posting unreliable (e.g., the Claude agent sometimes skips the step), and this feature is meant to add a deterministic backup at the orchestrator level? Or should the clarify-phase posting be removed in favor of orchestrator-level posting?
**Options**:
- A: Add orchestrator-level posting as a reliable backup/replacement, remove the clarify-phase posting
- B: Add orchestrator-level posting as a backup, keep the clarify-phase posting too (idempotent/deduped)
- C: The clarify-phase posting is broken/unreliable — fix it there instead of adding orchestrator-level posting

**Answer**: A — Add orchestrator-level posting as the reliable mechanism, remove the clarify-phase posting. The clarify operation already returns `questions` and `clarifications_file` in its output. The orchestrator has deterministic control over the posting flow and can guarantee ordering relative to labels. Having the Claude agent post via `gh issue comment` inside the clarify phase is fragile — the agent could skip it, format it differently, or fail partway through. Moving this responsibility to the orchestrator makes it reliable and testable.

### Q2: Implementation Location
**Context**: The spec proposes two alternatives — (1) direct insertion in `phase-loop.ts` after `labelManager.onGateHit()`, or (2) making it a responsibility of `StageCommentManager` to include questions in the stage comment when the gate is `waiting-for:clarification`.
**Question**: Which approach is preferred? A standalone comment (approach 1) means questions appear as a separate issue comment with their own notification. Including in the stage comment (approach 2) is cleaner but may be less visible since the stage comment is updated in-place.
**Options**:
- A: Standalone comment in phase-loop.ts (separate notification, more visible)
- B: Include in StageCommentManager stage comment (cleaner, but updated in-place)

**Answer**: A — Standalone comment in `phase-loop.ts`. Clarification questions are actionable — they need a response. A separate comment triggers a distinct GitHub notification, making it much more visible. The stage comment is an in-place-updated progress tracker; burying questions there means developers might miss them. Clean separation of concerns: stage comment tracks progress, question comment solicits input.

### Q3: Clarifications File Path Resolution
**Context**: The orchestrator's phase-loop runs after the Claude Code session completes. The worktree checkout path is available in the context, but `clarifications.md` lives inside a `specs/{issue}-{name}/` subdirectory whose exact name must be discovered.
**Question**: How should the orchestrator locate `clarifications.md`? Should it glob for `specs/{issueNumber}-*/clarifications.md`, or should the clarify phase output the file path as part of its result?
**Options**:
- A: Glob for the file using the issue number pattern
- B: Have the clarify phase return the file path in its output
- C: Use a well-known convention like `specs/{issueNumber}/clarifications.md` (would require changing spec directory naming)

**Answer**: B — Have the clarify phase return the file path in its output. The clarify operation already returns `clarifications_file` in its `ClarifyOutput`. The orchestrator can use that path directly — no globbing needed, no conventions to maintain. Most precise and least fragile approach.

### Q4: Comment Ordering vs Label Timing
**Context**: AC states "The comment is posted before the `agent:paused` label is applied (so watchers see the questions in the notification)." Currently `labelManager.onGateHit()` adds both `waiting-for:clarification` AND `agent:paused` in a single call. Posting the comment first would require restructuring the gate-hit flow.
**Question**: Is the strict ordering (comment before `agent:paused` label) a hard requirement? If so, should `onGateHit()` be split into two calls, or should the comment be posted before calling `onGateHit()` at all?
**Options**:
- A: Hard requirement — post comment first, then call onGateHit()
- B: Best-effort — post comment alongside gate-hit, ordering not critical
- C: Split onGateHit() into separate gate-label and paused-label calls with comment in between

**Answer**: A — Hard requirement: post comment first, then call `onGateHit()`. The whole point is that watchers see the questions in the notification triggered by the `agent:paused` label. If the label fires first, the notification email won't include the questions. Just reorder the calls — post comment before `labelManager.onGateHit()`. No need to split `onGateHit()`.
