# Research: Post Clarification Questions to Issue

## Technology Decisions

### 1. Orchestrator-level posting replaces clarify-phase posting

**Decision**: Remove clarify-phase `gh issue comment` posting (clarify.ts lines 268-305), replace with orchestrator-level posting

**Rationale**:
- The clarify operation posts via `gh issue comment` inside the Claude Code session — agent-driven and unreliable
- The orchestrator has deterministic control over the flow and can guarantee ordering relative to labels
- Single source of truth: orchestrator owns the posting responsibility
- Clarify operation still generates `clarifications.md` and returns structured output

### 2. Standalone comment (not stage comment)

**Decision**: Post as a new standalone issue comment

**Rationale**:
- Stage comments are updated in-place via `StageCommentManager` — no notification on edit
- A new comment triggers email/notification for issue subscribers
- Questions are actionable and deserve their own notification
- Clean separation: stage comment tracks progress, question comment solicits input

### 3. File location via glob

**Decision**: Glob for `specs/{issueNumber}-*/clarifications.md`

**Rationale**:
- Clarification answer preferred using `clarifications_file` from `ClarifyOutput`, but `PhaseResult` doesn't carry structured action output — only raw `OutputChunk[]`
- Adding structured output to `PhaseResult` is out of scope for this bug fix
- Globbing by issue number is reliable and avoids coupling to naming conventions
- Spec directories follow the predictable pattern `specs/{issueNumber}-{slug}/`

### 4. Comment posted before gate labels (hard requirement)

**Decision**: Post comment before calling `labelManager.onGateHit()`

**Rationale**:
- `onGateHit()` adds both `waiting-for:clarification` and `agent:paused` labels
- The `agent:paused` label triggers a GitHub notification
- Posting the comment first ensures it appears in the notification email
- Simple reordering — no need to split `onGateHit()`

### 5. Error handling: non-blocking

**Decision**: Errors logged but don't prevent gate-hit flow

**Rationale**:
- Clarification posting is a convenience feature, not critical path
- Gate labels, stage comments, and PR management must proceed regardless
- `try/catch` with warning log is sufficient

## Implementation Patterns

### Markdown parsing

The `parseQuestions()` function in `workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 107-147) provides a reference implementation. The orchestrator parser will be a simplified duplicate that:

1. Splits on `### Q\d+:` headers
2. Extracts `**Context**:`, `**Question**:`, `**Options**:` fields
3. Filters to only questions with `**Answer**: *Pending*`

Cross-package dependency is overkill for ~50 lines of parsing logic.

### GitHub comment format

```markdown
## Clarification Questions

The following questions need your input before we can proceed:

### Q1: [Topic]
**Context**: [Why this matters]

**Question**: [The question]

**Options**:
- A: [Option A description]
- B: [Option B description]

---

*Reply to this issue with your answers. The workflow will resume when answers are detected.*
```

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| Fix clarify-phase posting only | Not deterministic — still agent-driven |
| Include in stage comment | No notification on edit; less visible |
| Use `ClarifyOutput.clarifications_file` | `PhaseResult` lacks structured action output |
| Extract parser to shared package | Cross-package dependency for ~50 lines of parsing |
| Post via webhook/bot | Over-engineered for this use case |
