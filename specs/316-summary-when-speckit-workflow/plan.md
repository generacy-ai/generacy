# Implementation Plan: Post Clarification Questions to Issue

**Feature**: Ensure clarification questions are visible on the GitHub issue when the `waiting-for:clarification` gate is hit
**Branch**: `316-summary-when-speckit-workflow`
**Status**: Complete

## Summary

When the speckit workflow hits the `waiting-for:clarification` gate, the orchestrator labels the issue but questions may not be visible. The clarify operation (`clarify.ts`) already attempts to post questions via `gh issue comment`, but this happens inside the Claude Code session and may be unreliable (agent-driven, not deterministic).

This fix adds a **deterministic backup** at the orchestrator level in `phase-loop.ts`: after the clarify phase completes and before the gate-hit labels are applied, the orchestrator reads `clarifications.md`, extracts pending questions, and posts them as a comment on the issue. This ensures questions are always visible regardless of whether the agent-level posting succeeded.

## Technical Context

- **Language**: TypeScript
- **Framework**: Node.js with pnpm workspaces
- **Key packages**: `packages/orchestrator`, `packages/workflow-engine`
- **GitHub API**: Uses `gh` CLI via `executeCommand()`, not Octokit
- **Testing**: Vitest

## Open Clarifications

The following questions from `clarifications.md` are still pending and may affect implementation:

1. **Q1 (Redundancy)**: Whether to keep the clarify-phase posting alongside orchestrator-level posting, or replace it. **Default assumption**: Add as backup, keep existing (option B — idempotent).
2. **Q2 (Location)**: Standalone comment in phase-loop vs StageCommentManager. **Default assumption**: Standalone comment in phase-loop (option A — more visible, separate notification).
3. **Q3 (File path)**: How to locate `clarifications.md`. **Default assumption**: Glob for `specs/{issueNumber}-*/clarifications.md` (option A).
4. **Q4 (Label ordering)**: Whether comment must be posted before `agent:paused`. **Default assumption**: Best-effort ordering (option B — post comment before `onGateHit()` call, but don't restructure if it fails).

## Implementation Approach

### Step 1: Add `clarifications.md` parser utility

Create a utility function to read and extract pending questions from `clarifications.md`.

**File**: `packages/orchestrator/src/worker/clarification-poster.ts` (new)

```typescript
export interface PendingQuestion {
  topic: string;
  context: string;
  question: string;
  options?: string[];
}

export function parsePendingQuestions(content: string): PendingQuestion[] {
  // Split on ### Q<N>: headers
  // Extract topic, context, question, options
  // Only return questions where **Answer**: *Pending*
}

export function formatQuestionsComment(questions: PendingQuestion[]): string {
  // Format as readable GitHub comment with header
}

export async function postClarificationQuestions(opts: {
  checkoutPath: string;
  issueNumber: number;
  github: GitHubClient;
  owner: string;
  repo: string;
  logger: Logger;
}): Promise<void> {
  // 1. Glob for specs/{issueNumber}-*/clarifications.md
  // 2. Read and parse
  // 3. Format and post if pending questions exist
}
```

### Step 2: Integrate into phase-loop gate-hit handling

**File**: `packages/orchestrator/src/worker/phase-loop.ts` (modify lines 188-212)

Insert the clarification posting **before** `labelManager.onGateHit()`:

```typescript
// 6. Check for review gates
const gate = gateChecker.checkGate(phase, context.item.workflowName, config);
if (gate && gate.condition === 'always') {
  // Post clarification questions before applying gate labels
  if (gate.gateLabel === 'waiting-for:clarification') {
    await postClarificationQuestions({
      checkoutPath: context.checkoutPath,
      issueNumber: context.item.issueNumber,
      github: context.github,
      owner: context.item.owner,
      repo: context.item.repo,
      logger: this.logger,
    });
  }

  await labelManager.onGateHit(phase, gate.gateLabel);
  // ... rest unchanged
}
```

### Step 3: Add tests

**File**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (new)

- Test `parsePendingQuestions()` with various markdown formats
- Test `formatQuestionsComment()` output
- Test `postClarificationQuestions()` with mocked filesystem and GitHub client
- Test edge cases: missing file, no pending questions, all answered

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                          # Modified: call postClarificationQuestions
├── clarification-poster.ts                # New: parse + post logic
├── __tests__/
│   ├── clarification-poster.test.ts       # New: unit tests
│   └── phase-loop.test.ts                 # Modified: integration test for gate-hit
```

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `clarifications.md` format varies | Regex parser handles known variations; log warning on parse failure |
| Duplicate posting (clarify op + orchestrator) | Acceptable — second comment reinforces visibility |
| GitHub API failure | Wrap in try/catch; log error but don't block gate-hit flow (FR-005) |
| File not found in checkout | Graceful no-op with warning log |

## Dependencies

- No new npm packages required
- Uses existing `GitHubClient.addIssueComment()` and `fs`/`glob` from Node.js
- Uses existing `executeCommand` for `gh` CLI calls
