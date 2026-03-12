# Quickstart: Failed Phase Labels

## Overview

This feature adds `failed:<phase>` labels to GitHub issues when a workflow phase fails, making it immediately visible which phase caused the error.

## What Changes

### Before
When a phase fails, the issue gets:
- `agent:error` ← generic, no phase info

### After
When a phase fails, the issue gets:
- `agent:error`
- `failed:validate` ← specific phase that failed (NEW)

## Testing

### Run unit tests
```bash
cd packages/orchestrator
pnpm test -- label-manager.test.ts
pnpm test -- label-monitor-service.test.ts
```

### Manual verification
1. Trigger a workflow that will fail (e.g., issue with broken validate phase)
2. Check the issue labels — should see both `agent:error` and `failed:<phase>`
3. Re-process the issue (add `process:*` label)
4. Verify `failed:<phase>` label is removed along with other stale labels

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `failed:*` label not appearing | Label not created in repo | Run label sync / `ensureLabels` |
| Stale `failed:*` after reprocess | Missing cleanup in label-monitor-service | Check `processLabelEvent` includes `FAILED_LABEL_PREFIX` |
| Test failures | Updated assertion expectations | Ensure `addLabels` mock expects `['failed:<phase>', 'agent:error']` |
