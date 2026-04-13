# Data Model: Fix pre-existing test failures in claude-cli-worker.test.ts

## Core Types (Reference Only)

No new types are introduced. The relevant existing types are documented here for context.

### GitStatus (from `@generacy-ai/workflow-engine`)

```typescript
interface GitStatus {
  branch: string;
  has_changes: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}
```

### PHASES_REQUIRING_CHANGES (from `phase-loop.ts`)

```typescript
const PHASES_REQUIRING_CHANGES: ReadonlySet<WorkflowPhase> = new Set(['implement']);
```

Phases in this set must produce file changes (`has_changes: true`) to be considered successful.

## Mock Data Defaults

### Correct Default for Implement Phase Tests

```typescript
{
  branch: 'feature/42',
  has_changes: true,   // Must be true for implement phase to pass
  staged: [],
  unstaged: [],
  untracked: []
}
```

### Override for No-Changes Tests

Tests that explicitly need to verify no-changes behavior should override:

```typescript
mockGithub.getStatus.mockResolvedValue({
  branch: 'feature/42',
  has_changes: false,
  staged: [],
  unstaged: [],
  untracked: []
});
```
