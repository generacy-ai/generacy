# Quickstart: Post Clarification Questions to Issue

## Overview

This feature adds deterministic posting of clarification questions to GitHub issues when the orchestrator hits the `waiting-for:clarification` gate.

## Files to Modify/Create

1. **New**: `packages/orchestrator/src/worker/clarification-poster.ts`
2. **Modify**: `packages/orchestrator/src/worker/phase-loop.ts` (lines 188-195)
3. **New**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`

## Development

```bash
# Install dependencies
pnpm install

# Run orchestrator tests
pnpm --filter orchestrator test

# Run specific test file
pnpm --filter orchestrator test clarification-poster

# Type check
pnpm --filter orchestrator tsc --noEmit
```

## Implementation Steps

1. Create `clarification-poster.ts` with:
   - `parsePendingQuestions(content: string): PendingQuestion[]`
   - `formatQuestionsComment(questions: PendingQuestion[]): string`
   - `postClarificationQuestions(opts): Promise<void>`

2. In `phase-loop.ts`, before `labelManager.onGateHit()`:
   ```typescript
   if (gate.gateLabel === 'waiting-for:clarification') {
     await postClarificationQuestions({ ... });
   }
   ```

3. Add unit tests for parsing, formatting, and the integration flow.

## Testing

### Manual verification
1. Create an issue with `workflow:speckit-feature` label
2. Let orchestrator run through specify → clarify
3. Verify: clarification questions appear as a comment on the issue
4. Verify: `waiting-for:clarification` and `agent:paused` labels are applied after the comment

### Edge cases to verify
- `clarifications.md` missing → no-op, warning logged
- All questions answered → no comment posted
- GitHub API error → logged, gate-hit flow continues

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Questions not posted | Check orchestrator logs for "clarification" entries |
| File not found | Verify `specs/{issueNumber}-*/clarifications.md` exists in checkout |
| Duplicate comments | Expected — clarify phase may also post; not harmful |
| API error | Check `gh auth status` and repo permissions |
