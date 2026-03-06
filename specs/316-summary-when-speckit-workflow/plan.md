# Implementation Plan: Post Clarification Questions to Issue

**Feature**: Ensure clarification questions are posted as a standalone GitHub issue comment when the `waiting-for:clarification` gate is hit
**Branch**: `316-summary-when-speckit-workflow`
**Status**: Complete

## Summary

When the speckit workflow hits the `waiting-for:clarification` gate after the clarify phase, the orchestrator labels the issue but never posts the clarification questions visibly. The clarify operation in `workflow-engine` attempts to post via `gh issue comment` inside the Claude Code session, but this is agent-driven and unreliable.

This fix adds **deterministic orchestrator-level posting** in `phase-loop.ts`: before the gate-hit labels are applied, the orchestrator reads `clarifications.md`, extracts pending questions, and posts them as a standalone comment on the issue. The existing clarify-phase posting in `clarify.ts` (lines 268-305) will be **removed** — the orchestrator is the single source of truth for this.

## Clarification Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Replace** clarify-phase posting with orchestrator-level posting (option A) | Orchestrator has deterministic control; agent posting is fragile |
| Q2 | **Standalone comment** in phase-loop.ts (option A) | Triggers separate GitHub notification; more visible than stage comment edit |
| Q3 | **Glob** for `specs/{issueNumber}-*/clarifications.md` (using option A, not B) | `PhaseResult` doesn't carry structured action output — `clarifications_file` is not accessible from the gate-hit block without modifying `PhaseResult` type, which is out of scope |
| Q4 | **Hard requirement**: post comment **before** `labelManager.onGateHit()` (option A) | Ensures watchers see questions in the notification triggered by `agent:paused` label |

## Technical Context

- **Language**: TypeScript
- **Framework**: Node.js with pnpm workspaces
- **Key packages**: `packages/orchestrator`, `packages/workflow-engine`
- **GitHub API**: Uses `GitHubClient` interface (not raw `gh` CLI)
- **Testing**: Vitest
- **Existing parser**: `parseQuestions()` in `workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 107-147) — will be duplicated in orchestrator since cross-package dependency is overkill for ~50 lines

## Implementation Approach

### Step 1: Create `clarification-poster.ts` (new file)

**File**: `packages/orchestrator/src/worker/clarification-poster.ts`

```typescript
export interface PendingQuestion {
  number: number;
  topic: string;
  context: string;
  question: string;
  options?: string[];
}

export function parsePendingQuestions(content: string): PendingQuestion[]
// Split on ### Q\d+: headers
// Extract topic, context, question, options
// Only return questions where **Answer**: *Pending*

export function formatQuestionsComment(questions: PendingQuestion[]): string
// Format as readable GitHub comment with header and footer

export async function postClarificationQuestions(opts: {
  checkoutPath: string;
  issueNumber: number;
  github: GitHubClient;
  owner: string;
  repo: string;
  logger: Logger;
}): Promise<void>
// 1. Glob for specs/{issueNumber}-*/clarifications.md
// 2. Read and parse
// 3. If pending questions exist, format and post as issue comment
// 4. Non-blocking: catch errors, log warning, don't throw
```

### Step 2: Integrate into `phase-loop.ts` gate-hit handling

**File**: `packages/orchestrator/src/worker/phase-loop.ts` (modify lines 188-195)

Insert clarification posting **before** `labelManager.onGateHit()`:

```typescript
// 6. Check for review gates
const gate = gateChecker.checkGate(phase, context.item.workflowName, config);
if (gate && gate.condition === 'always') {
  this.logger.info(
    { phase, gateLabel: gate.gateLabel },
    'Gate hit, pausing workflow',
  );

  // Post clarification questions BEFORE applying gate labels
  // so watchers see the questions in the notification
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

### Step 3: Remove clarify-phase posting from `clarify.ts`

**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 268-305)

Remove the `gh issue comment` posting logic. The clarify operation will still:
- Generate `clarifications.md`
- Parse questions
- Return `ClarifyOutput` with `questions` and `clarifications_file`

But it will **not** post to the issue — that's now the orchestrator's job.

### Step 4: Add tests

**File**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (new)

- `parsePendingQuestions()`: various markdown formats, mixed answered/pending
- `formatQuestionsComment()`: output format, emoji header, footer text
- `postClarificationQuestions()`: mocked fs + GitHub client
- Edge cases: missing file, no pending questions, all answered, GitHub API error (logged, not thrown)

**File**: `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` (modify)

- Add test for gate-hit with `waiting-for:clarification` calling `postClarificationQuestions`
- Verify ordering: comment posted before `onGateHit()`

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                          # Modified: call postClarificationQuestions before onGateHit
├── clarification-poster.ts                # New: parse + format + post logic
├── __tests__/
│   ├── clarification-poster.test.ts       # New: unit tests
│   └── phase-loop.test.ts                 # Modified: integration test

packages/workflow-engine/src/actions/builtin/speckit/operations/
├── clarify.ts                             # Modified: remove gh issue comment posting (lines 268-305)
```

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `clarifications.md` format varies | Regex parser handles known variations; log warning on parse failure |
| GitHub API failure during posting | Wrap in try/catch; log error but don't block gate-hit flow |
| File not found in checkout | Graceful no-op with warning log |
| Removing clarify-phase posting breaks something | The posting there is a side effect; removing it simplifies the operation |

## Dependencies

- No new npm packages required
- Uses existing `GitHubClient.addIssueComment(owner, repo, number, body)` from `workflow-engine/src/actions/github/client/interface.ts`
- Uses Node.js `fs` and `glob` for file discovery
- Reference parser: `parseQuestions()` in `workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 107-147)
