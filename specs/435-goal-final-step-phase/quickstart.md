# Quickstart: Phase 3 Cleanup

## Prerequisites

- Wave 3 Phase 3a (#429), 3b (#430), 3c must be merged to `develop`
- Node.js 20+, pnpm

## Setup

```bash
git checkout 435-goal-final-step-phase
pnpm install
```

## Development Workflow

```bash
# Typecheck after changes
cd packages/orchestrator && pnpm typecheck

# Run tests
cd packages/orchestrator && pnpm test

# Run specific test files
npx vitest run src/worker/__tests__/cli-spawner.test.ts
npx vitest run src/worker/__tests__/phase-loop.test.ts
npx vitest run src/conversation/__tests__/conversation-spawner.test.ts
```

## Verification Commands

After implementation, run these to confirm acceptance criteria:

```bash
# AC: PHASE_TO_COMMAND removed from orchestrator
grep -rn "PHASE_TO_COMMAND" packages/orchestrator/src/
# Expected: 0 results

# AC: "claude" literals audit
grep -rn '"claude"\|'\''claude'\''' packages/orchestrator/src/ --include='*.ts' | grep -v __tests__ | grep -v __snapshots__
# Expected: only process spawn commands in cli-spawner.ts and pr-feedback-handler.ts

# AC: Build succeeds
cd packages/orchestrator && pnpm build

# AC: All tests pass
cd packages/orchestrator && pnpm test
```

## Files to Modify

| File | Action |
|------|--------|
| `packages/orchestrator/src/worker/types.ts` | Delete `PHASE_TO_COMMAND` constant |
| `packages/orchestrator/src/worker/index.ts` | Remove `PHASE_TO_COMMAND` re-export |
| `packages/orchestrator/src/worker/phase-loop.ts` | Replace `PHASE_TO_COMMAND` with inline checks |
| `packages/orchestrator/src/worker/cli-spawner.ts` | Remove import, inline command derivation |
| `packages/orchestrator/src/conversation/conversation-spawner.ts` | Delete `PTY_WRAPPER`, deprecated `spawn()`, import from plugin |
| Test files | Update for removed code, update snapshots |

## Troubleshooting

**TypeScript error after deleting PHASE_TO_COMMAND**: Check that all import sites have been updated. Run `grep -rn PHASE_TO_COMMAND packages/orchestrator/src/` to find stragglers.

**Test snapshot mismatch**: Run `npx vitest run --update` in the orchestrator package to regenerate snapshots after command derivation changes.

**PTY_WRAPPER import error**: Verify the plugin package exports `PTY_WRAPPER` from its public API. Check `packages/generacy-plugin-claude-code/src/index.ts` barrel exports.
