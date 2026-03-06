# Quickstart: Post Clarification Questions on Issue

## What This Changes

After the clarify phase completes, the orchestrator now automatically posts pending clarification questions as a comment on the GitHub issue. Previously, questions were only saved to `clarifications.md` on the feature branch.

## Testing Locally

### 1. Run unit tests

```bash
cd packages/orchestrator
pnpm test -- clarification-poster
```

### 2. Integration test (manual)

1. Create an issue with the `workflow:speckit-feature` label
2. Let the orchestrator run through specify → clarify
3. Verify: the issue should now have a comment with the clarification questions
4. Verify: the `waiting-for:clarification` label is present

## Files Changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/clarification-poster.ts` | New class |
| `packages/orchestrator/src/worker/phase-loop.ts` | Call `ClarificationPoster` on gate hit |
| `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` | New tests |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` | Remove `gh issue comment` posting |

## Troubleshooting

### Questions not appearing on issue
- Check orchestrator logs for `ClarificationPoster` log entries
- Verify `clarifications.md` exists at `specs/{issueNumber}-*/clarifications.md` in the checkout
- Confirm pending questions have `**Answer**: *Pending*` format

### Duplicate comments
- The old `executeClarify()` posting has been removed — if duplicates appear, check that the updated `clarify.ts` is deployed
