# Research: Clarification Question Posting

## Root Cause Analysis

The clarify operation (`clarify.ts:268-305`) already posts questions via `gh issue comment`, but this can fail silently:
- The `executeCommand('gh', ...)` call is wrapped in try/catch that only logs a warning (line 302)
- If the shell environment lacks `gh` auth or the command times out, questions are silently dropped
- The orchestrator has no awareness of whether posting succeeded

## Technology Decisions

### Decision 1: Octokit API vs `gh` CLI
**Choice**: Octokit API (`context.github.addIssueComment()`)
**Rationale**: The orchestrator already uses Octokit for all GitHub interactions. Using `gh` CLI introduces a dependency on shell environment and auth configuration that may differ from the orchestrator's token.
**Alternative**: Keep `gh` CLI — rejected because it's inconsistent with orchestrator patterns.

### Decision 2: New module vs inline in phase-loop
**Choice**: New `clarification-poster.ts` module
**Rationale**: Parsing markdown and formatting comments is distinct from orchestration logic. A separate module is independently testable and reusable.
**Alternative**: Inline in phase-loop — rejected due to mixing concerns.

### Decision 3: Deduplication strategy
**Choice**: HTML comment marker in posted comment
**Rationale**: Follows existing `StageCommentManager` pattern with `<!-- generacy-stage:* -->` markers. Checking for existing markers before posting prevents duplicates regardless of whether clarify.ts or phase-loop posted first.
**Alternative**: Track posting state in a file/variable — rejected as more complex and fragile.

## Implementation Patterns

### Markdown Parsing
Clarifications.md follows a consistent format:
```markdown
### Q1: [topic]
**Context**: [context]
**Question**: [question]
**Options**: (optional)
- A) [option]
**Answer**: *Pending*  ← indicator for unresolved questions
```

Parse using regex patterns matching this structure. Key indicator: `**Answer**: *Pending*`.

### Comment Format Pattern
Follow the existing stage comment pattern:
1. HTML marker for dedup: `<!-- generacy-clarifications:{issueNumber} -->`
2. Header with context
3. Formatted questions
4. Answer instructions

### Error Handling Pattern
Follow orchestrator conventions:
- Structured logging via `context.logger`
- Non-fatal errors: warn and continue (posting failure must not block the workflow)
- Use existing retry utilities for transient GitHub API failures

## Key Sources

- `packages/orchestrator/src/worker/phase-loop.ts:220-264` — gate-hit handling
- `packages/orchestrator/src/worker/stage-comment-manager.ts` — HTML marker pattern
- `packages/orchestrator/src/worker/epic-post-tasks.ts:242-287` — comment posting pattern
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:268-305` — existing posting code
