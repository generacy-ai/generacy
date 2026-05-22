# Quickstart: Inject sibling-repo awareness into agent prompt

**Feature**: #688 — Phase 1 multi-repo

## Prerequisites

- Node >=22
- pnpm installed
- Orchestrator package dependencies installed (`pnpm install`)

## Verify the Implementation

### Run unit tests

```bash
cd /workspaces/generacy
pnpm -C packages/orchestrator test -- --run src/worker/__tests__/sibling-prompt.test.ts
pnpm -C packages/orchestrator test -- --run src/worker/__tests__/phase-loop.test.ts
```

### Manual smoke test

1. Start the development stack:
   ```bash
   /workspaces/tetrad-development/scripts/stack start
   source /workspaces/tetrad-development/scripts/stack-env.sh
   ```

2. Ensure sibling repos are cloned under `/workspaces/`:
   ```bash
   ls /workspaces/  # should show multiple repos
   ```

3. Trigger a workflow with sibling repos configured and inspect the conversation log / stream-json output. The first message to the agent should contain:
   ```
   **Sibling repos available in this workspace.** You may edit files in any of these as part of this task:
   - `agency` — `/workspaces/agency`
   - `generacy-cloud` — `/workspaces/generacy-cloud`
   ```

4. Trigger a single-repo workflow (no siblings). Verify the prompt is identical to pre-feature behavior — no sibling block, no "no siblings" message.

## Key Files

| File | Purpose |
|------|---------|
| `packages/orchestrator/src/worker/sibling-prompt.ts` | Pure function: `buildSiblingPromptBlock()` |
| `packages/orchestrator/src/worker/phase-loop.ts` | Injection point (~line 185) |
| `packages/orchestrator/src/worker/types.ts` | `WorkerContext.siblingWorkdirs` field |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Stub population of `siblingWorkdirs` |

## Troubleshooting

**Q: Sibling block not appearing in prompt?**
Check that `context.siblingWorkdirs` is populated with non-empty array. In Phase 1, the field is stubbed as `[]` — it only produces a block when Issue A (#687) provides real data.

**Q: Tests failing after rebase?**
If Issue A (#687) has landed, the `siblingWorkdirs` stub in `claude-cli-worker.ts` may need updating to use the real data source instead of `[]`.
