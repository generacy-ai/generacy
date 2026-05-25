# Quickstart: Wire siblingFanoutHandler and complete agent prompt

## Verification Steps

### 1. Run affected tests

```bash
# Orchestrator worker tests
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/sibling-prompt.test.ts

# Workflow engine handler tests (should still pass — no changes to handler)
pnpm --filter @generacy-ai/workflow-engine test -- --run src/handlers/__tests__/sibling-fanout.test.ts

# Full test suite across affected packages
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/workflow-engine test
```

### 2. Verify handler registration

After implementation, confirm in `claude-cli-worker.ts`:
- `siblingFanoutHandler` is imported from `@generacy-ai/workflow-engine`
- It is the **first** entry in the `phaseAfterHandlers` array
- The linkedPRs reader is the **second** entry
- The SiblingFanoutContext is correctly constructed from PhaseAfterContext fields

### 3. Verify prompt output

After implementation, confirm in `sibling-prompt.ts`:
- `buildSiblingPromptBlock({ foo: '/bar' })` returns a string ending with the auto-PR sentence
- Empty input still returns `undefined`

### 4. TypeScript compilation check

```bash
pnpm --filter @generacy-ai/orchestrator build
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `siblingFanoutHandler is not exported` | Wrong import path | Import from `@generacy-ai/workflow-engine` (check `handlers/index.ts` exports) |
| `workflowState` undefined at handler call | State not loaded before handler | Construct `FilesystemWorkflowStore` and call `loadState(workflowId)` inside handler |
| Snapshot test fails | Expected string doesn't include auto-PR sentence | Update inline assertions to match new prompt format |
| Handler throws but no sibling changes | Handler may error on empty siblingWorkdirs | Guard with `if (Object.keys(siblingWorkdirs).length === 0) return` |
