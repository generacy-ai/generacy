# Data Model: Track Linked Sibling PRs in WorkflowState

## Core Entities

### LinkedPR (new)

Represents a pull request in a sibling repository, linked to the current workflow.

```typescript
export interface LinkedPR {
  /** Repository name (e.g. "generacy-cloud", "cluster-base") */
  repo: string;
  /** PR number within the repository */
  number: number;
  /** Branch name the PR was created from */
  branch: string;
  /** Full URL to the PR (e.g. "https://github.com/generacy-ai/generacy-cloud/pull/42") */
  url: string;
}
```

**Identity key**: `repo + number` (composite). Used for de-duplication in `addLinkedPR()`.

### WorkflowState (modified)

```typescript
export interface WorkflowState {
  version: '1.0';
  workflowId: string;
  workflowFile: string;
  currentPhase: string;
  currentStep: string;
  inputs: Record<string, unknown>;
  stepOutputs: Record<string, StepOutputData>;
  pendingReview?: PendingReview;
  linkedPRs?: LinkedPR[];        // <-- NEW: optional array of sibling PRs
  startedAt: string;
  updatedAt: string;
}
```

## Validation Rules

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `linkedPRs` | `LinkedPR[]` | No | If present, must be an array |
| `linkedPRs[].repo` | `string` | Yes (per entry) | Non-empty string |
| `linkedPRs[].number` | `number` | Yes (per entry) | Must be a number |
| `linkedPRs[].branch` | `string` | Yes (per entry) | Non-empty string |
| `linkedPRs[].url` | `string` | Yes (per entry) | Non-empty string |

## Relationships

```
WorkflowState 1──* LinkedPR (optional, embedded array)
```

`LinkedPR` entries are embedded directly in the `WorkflowState` JSON. No separate storage or foreign keys. The array is serialized/deserialized as part of the standard `JSON.stringify`/`JSON.parse` cycle in `FilesystemWorkflowStore`.

## Serialization

JSON example with `linkedPRs`:

```json
{
  "version": "1.0",
  "workflowId": "wf-abc123",
  "workflowFile": "workflows/feature.yaml",
  "currentPhase": "implement",
  "currentStep": "fan_out",
  "inputs": { "feature_dir": "specs/689" },
  "stepOutputs": {},
  "linkedPRs": [
    {
      "repo": "generacy-cloud",
      "number": 42,
      "branch": "689-phase-1-multi-repo",
      "url": "https://github.com/generacy-ai/generacy-cloud/pull/42"
    },
    {
      "repo": "cluster-base",
      "number": 15,
      "branch": "689-phase-1-multi-repo",
      "url": "https://github.com/generacy-ai/cluster-base/pull/15"
    }
  ],
  "startedAt": "2026-05-22T10:00:00Z",
  "updatedAt": "2026-05-22T10:05:00Z"
}
```

## Helper Function

```typescript
addLinkedPR(state: WorkflowState, entry: LinkedPR): WorkflowState
```

- **Input**: Current state + a `LinkedPR` entry to add
- **Output**: New `WorkflowState` with `linkedPRs` updated (does not mutate input)
- **De-duplication**: If `repo + number` already exists, replaces the entry (updates branch/url)
- **Initialization**: If `state.linkedPRs` is `undefined`, treats as empty array
