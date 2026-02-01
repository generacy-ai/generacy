# Implementation Plan: G2 - Implement Workflow with Humancy Checkpoints

**Feature**: Implement the tasks-to-issues Generacy workflow with Humancy review checkpoints
**Branch**: `163-g2-implement-workflow-humancy`
**Status**: Complete

## Summary

This feature extends the existing workflow-engine with a new `humancy.request_review` action handler that integrates with the Humancy human-in-the-loop system. The action enables workflows to pause execution, request human review of artifacts, and resume based on approval/rejection responses. Additionally, we implement filesystem-based workflow state persistence to support resume after human review.

## Technical Context

- **Language**: TypeScript
- **Runtime**: Node.js
- **Framework**: Workflow Engine (packages/workflow-engine)
- **Dependencies**:
  - Existing `workflow-engine` executor and action registry
  - Existing `humancy-connection.ts` transport layer
  - Existing `human-handler.ts` decision routing
  - `tasks-to-issues.yaml` workflow definition (from G1)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Workflow Executor                          │
│  (packages/workflow-engine/src/executor/index.ts)               │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Action Registry                            │
│  (packages/workflow-engine/src/actions/registry.ts)             │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐       │
│  │workspace.*  │ │agent.invoke │ │humancy.request_review│ ◄─NEW │
│  └─────────────┘ └─────────────┘ └──────────────────────┘       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│               Humancy Request Review Action                     │
│  (packages/workflow-engine/src/actions/humancy-review.ts)       │
│  - Builds review request from step config                       │
│  - Saves workflow state to filesystem                           │
│  - Routes to HumanHandler for decision                          │
│  - Returns approval result for conditional execution            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Human Handler                               │
│  (src/worker/handlers/human-handler.ts)                         │
│  - Sends decision_request to Humancy                            │
│  - Handles correlation and timeout                              │
│  - Returns HumanJobResult                                       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Humancy Connection                            │
│  (src/connections/humancy-connection.ts)                        │
│  - Transport layer (VS Code or cloud)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
packages/workflow-engine/
├── src/
│   ├── actions/
│   │   ├── index.ts                    # Action registry (MODIFY - register new action)
│   │   ├── base-action.ts              # Base class (reference only)
│   │   └── humancy-review.ts           # NEW - Humancy review action handler
│   ├── store/
│   │   ├── index.ts                    # Store exports (MODIFY - add filesystem store)
│   │   ├── memory-store.ts             # Existing in-memory store (reference only)
│   │   └── filesystem-store.ts         # NEW - Filesystem persistence
│   └── types/
│       └── store.ts                    # Store interface (MODIFY if needed)

src/
├── worker/
│   └── handlers/
│       └── human-handler.ts            # Existing handler (minor extension if needed)
```

## Key Implementation Components

### 1. HumancyReviewAction (New Action Handler)

Extends `BaseAction` to handle `humancy.request_review` steps:

```typescript
// Input configuration (from workflow YAML)
interface HumancyReviewInput {
  artifact: string;      // Content or path to review
  context: string;       // Review instructions
  urgency?: 'low' | 'normal' | 'blocking_soon' | 'blocking_now';
  timeout?: number;      // Override default timeout
}

// Output (stored for subsequent steps)
interface HumancyReviewOutput {
  approved: boolean;
  comments?: string;
  respondedBy?: string;
  respondedAt?: string;
}
```

### 2. FilesystemWorkflowStore (New Store Implementation)

Persists workflow state to `.generacy/workflow-state.json`:

```typescript
interface WorkflowState {
  workflowId: string;
  currentPhase: string;
  currentStep: string;
  stepOutputs: Record<string, StepOutput>;
  pendingReview?: {
    reviewId: string;
    artifact: string;
    requestedAt: string;
  };
  startedAt: string;
  updatedAt: string;
}
```

### 3. Action Registration

Add to action registry in `packages/workflow-engine/src/actions/index.ts`:

```typescript
import { HumancyReviewAction } from './humancy-review';

export const defaultActions: BaseAction[] = [
  // ... existing actions
  new HumancyReviewAction(),
];
```

## Execution Flow

1. **Workflow reaches `humancy.request_review` step**
2. **HumancyReviewAction.executeInternal()** is called:
   - Interpolates artifact and context from step config
   - Saves current workflow state to filesystem
   - Calls HumanHandler.requestDecision()
3. **HumanHandler routes to Humancy**:
   - Sends `decision_request` message
   - Waits for `decision_response` (with timeout)
4. **Response received**:
   - HumancyReviewAction returns result with `approved`, `comments`
   - Result stored in `stepOutputs['review']`
5. **Subsequent steps can use** `${steps.review.approved}` for conditional execution

## Error Handling Strategy

Based on clarification Q3 (preserve issues, report partial success):

1. **On action failure**: Log error, preserve any created resources, report partial state
2. **On timeout**: Return failure with timeout reason, workflow can be resumed
3. **On rejection**: Return `approved: false`, workflow continues to conditional logic

## State Persistence Strategy

Based on clarification Q4 (local filesystem):

- State file: `.generacy/workflow-state.json`
- Created/updated at each checkpoint
- Includes all data needed for resume:
  - Workflow ID and definition reference
  - Current phase/step position
  - All previous step outputs
  - Pending review details if paused

## Testing Strategy

1. **Unit tests**: Action handler logic, state serialization
2. **Integration tests**: Full workflow execution with mock Humancy
3. **Manual tests**: Real Humancy integration via VS Code extension

## Dependencies

- G1 complete (workflows/tasks-to-issues.yaml exists)
- Existing workflow-engine infrastructure
- Existing Humancy connection layer

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| State file corruption | JSON schema validation on load, backup before write |
| Timeout during long reviews | Configurable timeout with reasonable default (24h) |
| Concurrent workflow executions | Lock file or workflow ID uniqueness check |

---

*Generated by speckit*
