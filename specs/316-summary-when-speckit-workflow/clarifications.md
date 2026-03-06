# Clarification Questions

## Status: Pending

## Questions

### Batch 1 — 2026-03-06

### Q1: Duplicate posting with clarify operation
**Context**: The clarify operation (`clarify.ts` lines 293-305) already has code that posts questions to GitHub via `gh issue comment` when generating clarifications. If the gate-hit handler also posts questions, they may appear twice on the issue.
**Question**: Is the existing posting in the clarify operation failing/not executing, and this fix should ensure it works? Or should the gate-hit handler act as a second safety net that posts questions even if the clarify operation didn't?
**Options**:
- A: Fix the clarify operation's existing posting so it works reliably
- B: Add redundant posting at gate-hit time as a safety net (accept possible duplicates)
- C: Move posting responsibility entirely to the gate-hit handler and remove it from the clarify operation

**Answer**: *Pending*

### Q2: Implementation location
**Context**: The spec explicitly offers two alternatives: adding logic in `phase-loop.ts` after `labelManager.onGateHit()`, or making it a `StageCommentManager` responsibility. These have different architectural implications — phase-loop keeps it as a one-off side effect, while StageCommentManager makes it a reusable concern.
**Question**: Which implementation location should be used for posting clarification questions on gate hit?
**Options**:
- A: In `phase-loop.ts` directly after `labelManager.onGateHit()` — simplest, keeps it as a gate-specific side effect
- B: In `StageCommentManager` as a new method — more structured, but extends the manager's responsibility beyond stage tracking

**Answer**: *Pending*

### Q3: Clarifications.md file path resolution
**Context**: The spec says to read `clarifications.md` "from the working directory," but actual clarification files live in `specs/{issue-number}-{slug}/clarifications.md` (e.g., `specs/316-summary-when-speckit-workflow/clarifications.md`). The gate-hit handler needs to know the correct spec directory path.
**Question**: How should the gate-hit handler locate `clarifications.md`? Should it search the `specs/` directory for the matching issue number, or is the spec directory path already available in the phase-loop context?

**Answer**: *Pending*

### Q4: Comment format and answering UX
**Context**: The spec says questions should be "clearly formatted" and "easy to answer" but doesn't specify the exact format. The orchestrator's resume flow expects answers in a specific format (e.g., `Q1: answer`). The comment format affects whether humans can answer inline or need to follow a template.
**Question**: Should the posted comment include instructions for how to answer (e.g., "Reply with Q1: your answer, Q2: your answer")? Or just display the questions and let the human figure out the format?
**Options**:
- A: Include answering instructions with the expected format template
- B: Just display questions — the existing workflow documentation covers the answer format

**Answer**: *Pending*
