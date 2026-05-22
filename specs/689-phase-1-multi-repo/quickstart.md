# Quickstart: Track Linked Sibling PRs in WorkflowState

## What Changed

The `WorkflowState` type now supports an optional `linkedPRs` array for tracking PRs created in sibling repositories during cross-repo workflows.

## Usage

### Importing

```typescript
import { addLinkedPR } from '@generacy-ai/workflow-engine';
import type { LinkedPR, WorkflowState } from '@generacy-ai/workflow-engine';
```

### Adding a linked PR

```typescript
const entry: LinkedPR = {
  repo: 'generacy-cloud',
  number: 42,
  branch: '689-phase-1-multi-repo',
  url: 'https://github.com/generacy-ai/generacy-cloud/pull/42',
};

// Returns a new state object (does not mutate)
const updatedState = addLinkedPR(currentState, entry);
```

### Idempotent behavior

Calling `addLinkedPR` twice with the same `repo + number` updates the entry rather than duplicating it:

```typescript
const state1 = addLinkedPR(state, { repo: 'cloud', number: 1, branch: 'old', url: 'old-url' });
const state2 = addLinkedPR(state1, { repo: 'cloud', number: 1, branch: 'new', url: 'new-url' });

// state2.linkedPRs has exactly 1 entry with branch: 'new', url: 'new-url'
```

### Reading linked PRs

```typescript
const linkedPRs = state.linkedPRs ?? [];
for (const pr of linkedPRs) {
  console.log(`${pr.repo}#${pr.number}: ${pr.url}`);
}
```

## Verification

```bash
# Type-check
cd packages/workflow-engine
pnpm tsc --noEmit

# Run tests
pnpm vitest run src/store/
```

## Backward Compatibility

- Existing state files without `linkedPRs` load without error (field is optional)
- No schema version change required
- No migration needed

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Type error on `linkedPRs` | Old `@generacy-ai/workflow-engine` version | Rebuild: `pnpm build` in workflow-engine |
| Validation error on load | Malformed `linkedPRs` in state file | Check JSON: entries need `repo` (string), `number` (number), `branch` (string), `url` (string) |
