# Research: Post Clarification Questions to Issue

## Technology Decisions

### 1. Standalone comment vs. stage comment update

**Decision**: Standalone comment (new issue comment)

**Rationale**:
- Stage comments are updated in-place via `StageCommentManager` — watchers don't get notifications for edits
- A new comment triggers email/notification for issue subscribers
- Questions deserve their own notification to attract attention
- Stage comment remains focused on progress tracking

### 2. Orchestrator-level posting vs. fixing clarify-phase posting

**Decision**: Add orchestrator-level posting as a deterministic backup

**Rationale**:
- The clarify operation (`clarify.ts` lines 268-305) already posts questions via `gh issue comment` inside the Claude Code session
- However, this is agent-driven — the agent may skip or fail the step
- Orchestrator-level posting is deterministic: it runs after the phase completes, outside the agent session
- Keeping both provides defense-in-depth; the duplicate is acceptable

### 3. File location strategy

**Decision**: Glob for `specs/{issueNumber}-*/clarifications.md`

**Rationale**:
- Spec directories follow the pattern `specs/{issueNumber}-{slug}/`
- The slug portion varies and is not predictable from the orchestrator context
- Globbing by issue number is reliable and avoids coupling to naming conventions
- Node.js `glob` or `fs.readdirSync` + filter is straightforward

### 4. Error handling strategy

**Decision**: Non-blocking — errors are logged but don't prevent gate-hit flow

**Rationale**:
- FR-005 explicitly requires this: "Should not block the gate-hit flow"
- The clarification posting is a convenience feature, not critical path
- Gate labels, stage comments, and PR management must proceed regardless

## Implementation Patterns

### Markdown parsing

The clarify operation in `workflow-engine` already has a `parseQuestions()` function (lines 107-147). However:
- It's in `workflow-engine`, not `orchestrator`
- It parses a slightly different format (initial generation vs. committed file)
- Duplicating a small regex parser is simpler than adding a cross-package dependency

The orchestrator parser needs to:
1. Split on `### Q\d+:` headers
2. Extract `**Context**:`, `**Question**:`, `**Options**:` fields
3. Filter to only questions with `**Answer**: *Pending*`

### GitHub comment format

```markdown
## 🔍 Clarification Questions

The following questions need your input before we can proceed:

### Q1: [Topic]
**Context**: [Why this matters]

**Question**: [The question]

**Options**:
- A: [Option A description]
- B: [Option B description]

---

*Please answer by replying to this issue. The workflow will resume automatically when answers are detected.*
```

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| Fix clarify-phase posting only | Not deterministic — still agent-driven |
| Include in stage comment | No notification on edit; less visible |
| Post via webhook/bot | Over-engineered for this use case |
| Extract to shared package | Cross-package dependency for ~50 lines of parsing |
