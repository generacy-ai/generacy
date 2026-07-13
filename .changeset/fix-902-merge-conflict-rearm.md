---
"@generacy-ai/orchestrator": patch
---

Re-arm the interrupted phase after a merge-conflict resolution and leave labels truthful (#902).

#898's `MergeConflictHandler` success path (agent-resolved or no-op when the
branch was already clean) never re-armed the paused phase and left
`agent:in-progress` and `completed:merge-conflicts` set — a state no detector
matches, so the issue dead-parked forever. The success path now:

- returns a terminal `{ outcome: 're-armed', startPhase }` to the dispatcher,
  which (as the single queue authority per #889) completes the handler's own
  claim and enqueues the `continue` item — the handler never touches the queue
  itself, avoiding a self-deadlock against #879's single-in-flight rule;
- sources `startPhase` from `ResolveMergeConflictsMetadata.phase` threaded in-band
  from the pause site, and fails loud with #889-style evidence if it's missing
  rather than re-deriving from labels;
- consumes the `completed:merge-conflicts` operator-advance marker and clears
  `agent:in-progress`/`agent:paused` residue so a later pause can't insta-resume.

Codifies the invariant that every handler terminal outcome maps to exactly one of
re-armed / gated / failed / done, enforced by a post-exit runtime assertion that
reads the real label set + queue state (not the handler's return value).
