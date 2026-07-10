---
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy-plugin-claude-code": minor
"@generacy-ai/workflow-engine": minor
---

Add the bounded merge-conflict resolution handler #864 deferred (#898).

`#864` shipped the pre-phase base-merge guardrail and the
`waiting-for:merge-conflicts` pause but deferred the actual resolver to a
follow-up that was never filed — so issues that paused at that gate could never
transition. This ships both halves:

- **Self-describing pause surface.** The merge-conflict pause comment now
  documents the manual escalation path (resolve on the branch, push, then
  advance) and stays load-bearing as the `blocked:stuck-merge-conflicts`
  escalation surface.
- **Bounded autonomous resolver.** A merge-conflict monitor enqueues a resolution
  item for issues sitting at `waiting-for:merge-conflicts`, and a new
  `MergeConflictHandler` (shaped like `PrFeedbackHandler`, driven by a new
  claude-code `MergeConflictIntent`) makes exactly one autonomous CLI attempt on
  the branch with #883-style termination discipline: pre-agent git/network flakes
  get bounded 3× retries, the agent runs at most once, and `git push` retries only
  network errors — a non-fast-forward rejection escalates to
  `blocked:stuck-merge-conflicts` rather than looping. On success it applies
  `completed:merge-conflicts` and clears the pause; on failure it preserves the
  gate and emits an evidence block. Adds the `blocked:stuck-merge-conflicts` label
  to the workflow-engine vocabulary.
