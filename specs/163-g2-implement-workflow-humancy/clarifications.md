# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-01 22:36

### Q1: Workflow Runner Infrastructure
**Context**: The spec mentions 'Generacy workflow runner infrastructure' as a dependency but doesn't clarify if it exists or needs to be built as part of this feature.
**Question**: Does the Generacy workflow runner infrastructure already exist, or does this feature need to implement it from scratch?
**Options**:
- A: Infrastructure exists - implement only the tasks-to-issues workflow handler
- B: Build the runner infrastructure as part of this feature
- C: Partial infrastructure exists - specify what's missing

**Answer**: *Pending*

### Q2: Humancy Plugin State
**Context**: The implementation depends on a Humancy plugin with specific APIs (requestReview, waitForReview). Implementation approach differs based on current state.
**Question**: What is the current state of the Humancy plugin? Is the API shown in the spec already implemented, or does this feature need to implement/extend it?
**Options**:
- A: Humancy plugin with shown API already exists
- B: Humancy plugin exists but needs API extensions
- C: Humancy plugin needs to be created as part of this feature

**Answer**: *Pending*

### Q3: Rollback Strategy
**Context**: The spec says 'optionally close/delete created issues' on failure. Without clear guidance, implementation might make wrong assumptions about destructive operations.
**Question**: When issue creation fails mid-way, should rollback automatically delete created issues, or should it preserve them and report what was created?
**Options**:
- A: Auto-delete created issues (clean rollback)
- B: Preserve issues, report partial success for manual cleanup
- C: Ask user at runtime via Humancy whether to delete or keep

**Answer**: *Pending*

### Q4: Workflow State Persistence
**Context**: saveWorkflowState() is called but the storage mechanism isn't specified. This affects reliability and resume capability.
**Question**: Where should workflow state be persisted for resume after human review?
**Options**:
- A: Local filesystem (e.g., .generacy/workflow-state.json)
- B: GitHub issue metadata/comments
- C: In-memory only (no persistence, user must restart workflow)

**Answer**: *Pending*

### Q5: Tasks-to-Issues YAML Source
**Context**: The feature references 'tasks-to-issues.yaml' but doesn't specify where this YAML definition comes from or if it needs to be created.
**Question**: Is the tasks-to-issues.yaml workflow definition already created (from G1), or does this feature need to define it?
**Options**:
- A: YAML exists from G1 - implement runner only
- B: Need to create the YAML as part of this feature

**Answer**: *Pending*

