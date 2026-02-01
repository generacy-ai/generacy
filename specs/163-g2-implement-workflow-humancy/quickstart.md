# Quickstart: G2 - Implement Workflow with Humancy Checkpoints

## Installation

This feature is part of the Generacy monorepo. No additional installation required.

## Prerequisites

1. **Workflow Engine**: Ensure `packages/workflow-engine` is built
   ```bash
   pnpm --filter workflow-engine build
   ```

2. **Humancy Connection**: Humancy must be connected (VS Code extension or cloud)

3. **Workflow YAML**: `workflows/tasks-to-issues.yaml` from G1 must exist

## Usage

### Running a Workflow with Human Review

```typescript
import { WorkflowExecutor } from '@generacy/workflow-engine';
import { FilesystemWorkflowStore } from '@generacy/workflow-engine/store';

// Initialize executor with filesystem store
const store = new FilesystemWorkflowStore('.generacy/workflow-state.json');
const executor = new WorkflowExecutor({ store });

// Execute workflow
const result = await executor.execute({
  workflowFile: 'workflows/tasks-to-issues.yaml',
  inputs: {
    feature_dir: 'specs/123-my-feature',
    grouping: 'per-story',
    dry_run: false
  }
});

// Workflow pauses at humancy.request_review step
// Human reviewer receives notification in Humancy
// Workflow resumes automatically after approval
```

### Resuming a Paused Workflow

```typescript
// List pending workflows
const pending = await store.listPending();
console.log('Pending workflows:', pending.map(w => w.workflowId));

// Resume specific workflow
const state = await store.load('wf_abc123');
if (state) {
  const result = await executor.resume(state);
}
```

### Workflow YAML Example

```yaml
name: tasks-to-issues
description: Convert tasks to backlog issues

steps:
  - id: preview
    uses: spec_kit.tasks_to_issues
    with:
      feature_dir: ${{ inputs.feature_dir }}
      dry_run: true

  - id: review
    uses: humancy.request_review
    with:
      artifact: ${{ steps.preview.output.summary }}
      context: |
        Review the issues that will be created.
        Check for:
        - Appropriate grouping
        - Clear titles and descriptions
        - Correct dependencies
      urgency: blocking_soon

  - id: create
    uses: spec_kit.tasks_to_issues
    if: ${{ steps.review.approved }}
    with:
      feature_dir: ${{ inputs.feature_dir }}
      dry_run: false
```

## Available Commands

### Action Types

| Action | Description |
|--------|-------------|
| `humancy.request_review` | Request human review of an artifact |

### Action Inputs

**humancy.request_review**:

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `artifact` | string | Yes* | Content to review |
| `context` | string | Yes* | Review instructions |
| `urgency` | enum | No | low, normal, blocking_soon, blocking_now |
| `timeout` | number | No | Timeout in ms (default: 24h) |

*At least one of `artifact` or `context` required.

### Action Outputs

**humancy.request_review**:

| Output | Type | Description |
|--------|------|-------------|
| `approved` | boolean | Whether review was approved |
| `comments` | string | Reviewer comments (if any) |
| `respondedBy` | string | Reviewer identifier |
| `respondedAt` | string | ISO timestamp of response |
| `reviewId` | string | Unique review request ID |

## Troubleshooting

### Workflow Not Resuming

**Symptom**: Workflow stays paused after approval in Humancy

**Checks**:
1. Verify state file exists: `cat .generacy/workflow-state.json`
2. Check `pendingReview.reviewId` matches the approval
3. Ensure Humancy connection is active

**Solution**: Manually trigger resume with `executor.resume(state)`

### Timeout Errors

**Symptom**: Action fails with timeout before human responds

**Cause**: Default 24h timeout exceeded

**Solution**: Increase timeout in step config:
```yaml
- id: review
  uses: humancy.request_review
  with:
    artifact: ...
    timeout: 172800000  # 48 hours
```

### State File Corruption

**Symptom**: Resume fails with JSON parse error

**Solution**:
1. Check `.generacy/workflow-state.json` for syntax errors
2. If unrecoverable, delete state file and restart workflow
3. Previous step outputs will need to be re-executed

### Missing Humancy Connection

**Symptom**: "No Humancy transport available" error

**Checks**:
1. Ensure VS Code extension is installed and connected
2. Or ensure cloud Humancy credentials are configured
3. Check `messageRouter` has Humancy handler registered

## Example Output

Successful workflow execution:

```json
{
  "success": true,
  "outputs": {
    "issues": [
      {
        "id": "123",
        "url": "https://github.com/org/repo/issues/123",
        "title": "Implement feature X",
        "provider": "github"
      }
    ]
  },
  "completedSteps": ["parse_tasks", "preview", "review", "create"],
  "duration": 45000
}
```

Workflow paused at review:

```json
{
  "success": false,
  "status": "paused",
  "pendingReview": {
    "reviewId": "rev_xyz789",
    "stepId": "review",
    "requestedAt": "2024-01-15T10:30:00Z"
  },
  "message": "Waiting for human approval"
}
```

---

*Generated by speckit*
