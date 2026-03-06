# Quickstart: Clarification Question Posting Fix

## Overview

This fix ensures clarification questions are posted as a visible comment on the GitHub issue when the `waiting-for:clarification` gate is hit, so humans can see and answer them directly.

## What Changes

1. **New file**: `packages/orchestrator/src/worker/clarification-poster.ts` — parses `clarifications.md` and posts questions to the issue
2. **Modified file**: `packages/orchestrator/src/worker/phase-loop.ts` — calls the poster after gate-hit

## Testing

```bash
# Run unit tests for the new module
pnpm --filter @generacy/orchestrator test -- clarification-poster

# Run all orchestrator tests
pnpm --filter @generacy/orchestrator test
```

## Verification

1. Create an issue with `workflow:speckit-feature` label
2. Let the orchestrator run through specify → clarify
3. When `waiting-for:clarification` gate is hit, verify:
   - Issue has `waiting-for:clarification` label (existing behavior)
   - Issue has a new comment with formatted clarification questions (new behavior)
   - Comment includes answering instructions

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No comment posted | `clarifications.md` not found | Check spec directory exists with matching issue number |
| Duplicate comments | Missing HTML marker check | Verify `<!-- generacy-clarifications:* -->` marker is in posted comment |
| Questions show as empty | Parse failure | Check `clarifications.md` follows expected markdown format |
| Gate blocks on post failure | Missing error handling | Posting is wrapped in try/catch — check logs for warnings |
