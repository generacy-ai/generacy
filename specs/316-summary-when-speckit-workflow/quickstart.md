# Quickstart: Post Clarification Questions to Issue

## Overview

This feature adds deterministic posting of clarification questions to GitHub issues when the orchestrator hits the `waiting-for:clarification` gate. It replaces the unreliable agent-level posting in the clarify phase.

## Files to Modify/Create

1. **New**: `packages/orchestrator/src/worker/clarification-poster.ts`
2. **Modify**: `packages/orchestrator/src/worker/phase-loop.ts` (gate-hit block, lines 188-195)
3. **Modify**: `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (remove lines 268-305)
4. **New**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`

## Development

```bash
# Install dependencies
pnpm install

# Run orchestrator tests
pnpm --filter orchestrator test

# Run specific test file
pnpm --filter orchestrator test clarification-poster

# Run workflow-engine tests (after removing clarify-phase posting)
pnpm --filter workflow-engine test

# Type check
pnpm --filter orchestrator tsc --noEmit
pnpm --filter workflow-engine tsc --noEmit
```

## Implementation Steps

1. Create `clarification-poster.ts` with:
   - `parsePendingQuestions(content: string): PendingQuestion[]`
   - `formatQuestionsComment(questions: PendingQuestion[]): string`
   - `postClarificationQuestions(opts): Promise<void>`

2. In `phase-loop.ts`, **before** `labelManager.onGateHit()`:
   ```typescript
   if (gate.gateLabel === 'waiting-for:clarification') {
     await postClarificationQuestions({ ... });
   }
   ```

3. Remove `gh issue comment` posting from `clarify.ts` (lines 268-305)

4. Add unit tests for parsing, formatting, and the integration flow

## Testing

### Manual verification
1. Create an issue with `workflow:speckit-feature` label
2. Let orchestrator run through specify → clarify
3. Verify: clarification questions appear as a standalone comment on the issue
4. Verify: comment is posted **before** `waiting-for:clarification` and `agent:paused` labels

### Edge cases to verify
- `clarifications.md` missing → no-op, warning logged
- All questions answered → no comment posted
- GitHub API error → logged, gate-hit flow continues unblocked

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Questions not posted | Check orchestrator logs for "clarification" entries |
| File not found | Verify `specs/{issueNumber}-*/clarifications.md` exists in checkout |
| API error | Check GitHub client auth and repo permissions |
