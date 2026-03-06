# Implementation Plan: Post Clarification Questions on Issue

**Feature**: When the speckit workflow hits the `waiting-for:clarification` gate, post the pending questions from `clarifications.md` as a comment on the GitHub issue so humans can see and answer them directly.
**Branch**: `316-summary-when-speckit-workflow`
**Status**: Complete

## Summary

The orchestrator correctly labels issues with `waiting-for:clarification` after the clarify phase, but never posts the actual questions as a visible comment. Users must manually find and read `clarifications.md` on the feature branch. This fix adds a dedicated `ClarificationPoster` class that reads the file, extracts pending questions, and posts them as a GitHub issue comment — all from the orchestrator level (removing the fragile `gh` CLI posting from `executeClarify()`).

## Technical Context

- **Language**: TypeScript
- **Runtime**: Node.js
- **Package**: `packages/orchestrator`
- **Key dependencies**: GitHub API client (already injected via `context.github`), `glob` for file discovery
- **Testing**: Vitest, no existing `phase-loop.test.ts`

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                    # MODIFY — add clarification posting after gate hit
├── clarification-poster.ts          # NEW — dedicated class for reading + posting clarifications
├── stage-comment-manager.ts         # REFERENCE ONLY — similar pattern for GitHub comments
├── label-manager.ts                 # REFERENCE ONLY — called before our new code
└── __tests__/
    └── clarification-poster.test.ts # NEW — unit tests for the new class

packages/workflow-engine/src/actions/builtin/speckit/operations/
└── clarify.ts                       # MODIFY — remove gh issue comment posting (lines 268-305)
```

## Implementation Steps

### Step 1: Create `ClarificationPoster` class

**File**: `packages/orchestrator/src/worker/clarification-poster.ts`

Responsibilities:
1. **Locate** `clarifications.md` via glob: `specs/{issueNumber}-*/clarifications.md`
2. **Parse** the markdown to extract pending questions (those with `**Answer**: *Pending*`)
3. **Format** questions into a readable GitHub issue comment
4. **Post** via `context.github.addIssueComment()`

The class follows the same dependency-injection pattern as `StageCommentManager`:
```typescript
export class ClarificationPoster {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
  ) {}

  async postPendingQuestions(checkoutPath: string): Promise<boolean> {
    // 1. Glob for clarifications.md
    // 2. Read and parse for pending questions
    // 3. Format and post as issue comment
    // Returns true if questions were posted
  }
}
```

### Step 2: Integrate into `phase-loop.ts`

**File**: `packages/orchestrator/src/worker/phase-loop.ts`

Insert between `labelManager.onGateHit()` (line ~241) and `stageCommentManager.updateStageComment()` (line ~254):

```typescript
// After: await labelManager.onGateHit(phase, gate.gateLabel);

// Post clarification questions to the issue
if (gate.gateLabel === 'waiting-for:clarification') {
  const poster = new ClarificationPoster(
    context.github, context.item.owner, context.item.repo,
    context.item.issueNumber, this.logger,
  );
  await poster.postPendingQuestions(context.checkoutPath);
}

// Before: result.gateHit = { ... }
```

### Step 3: Remove posting from `executeClarify()`

**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`

Remove lines 268-305 (the `gh issue comment` posting block). The orchestrator now owns this responsibility, using the authenticated GitHub client instead of the fragile `gh` CLI subprocess.

### Step 4: Add unit tests

**File**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`

Test cases:
- Parses pending questions from `clarifications.md` correctly
- Skips answered questions (non-`*Pending*` answers)
- Posts formatted comment via GitHub client
- Handles missing `clarifications.md` gracefully (no error, returns false)
- Handles file with no pending questions (no comment posted)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Implementation location | New `ClarificationPoster` class | Clean separation of concerns; independently testable (Q2→C) |
| Posting responsibility | Orchestrator only | Deterministic control, reliable auth, consistent formatting (Q1→A) |
| File discovery | Glob `specs/{issueNumber}-*/clarifications.md` | Works without structured phase output (Q3→B) |
| Gate specificity | Direct `if` check for `waiting-for:clarification` | Pragmatic bugfix, avoids over-engineering (Q4→A) |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `clarifications.md` not yet committed when orchestrator reads it | File is written to `checkoutPath` (working directory) before phase completes — no commit needed |
| Glob finds multiple matches | Use issue number prefix to narrow; take first match |
| Large number of questions | Truncate comment if exceeding GitHub's 65536 char limit |
