# Feature Specification: Plugin: @generacy-ai/generacy-plugin-github-actions

**Branch**: `016-plugin-generacy-ai-generacy` | **Date**: 2026-02-06 | **Status**: Draft

## Summary

Implement the GitHub Actions integration plugin for CI/CD workflows. This plugin extends the Latency `latency-plugin-github-actions` base plugin and provides Generacy-specific integration for workflow orchestration.

## Parent Epic

#11 - Generacy Official Plugins

## Dependencies

- #2 - Generacy Core Package
- Latency `latency-plugin-github-actions` base plugin (extends)
- Optional: `IssueTracker` facet provider at runtime (for status linking)

## Features

### Workflow Operations

```typescript
interface GitHubActionsPlugin {
  // Workflow triggering
  triggerWorkflow(workflow: string, inputs?: Record<string, string>): Promise<WorkflowRun>;
  triggerWorkflowDispatch(workflow: string, ref: string, inputs?: Record<string, string>): Promise<WorkflowRun>;
  
  // Run monitoring
  getWorkflowRun(runId: number): Promise<WorkflowRun>;
  listWorkflowRuns(workflow: string): Promise<WorkflowRun[]>;
  cancelWorkflowRun(runId: number): Promise<void>;
  rerunWorkflowRun(runId: number): Promise<WorkflowRun>;
  
  // Job details
  getJobs(runId: number): Promise<Job[]>;
  getJobLogs(jobId: number): Promise<string>;
  
  // Artifacts
  listArtifacts(runId: number): Promise<Artifact[]>;
  downloadArtifact(artifactId: number): Promise<Buffer>;
  
  // Check runs
  createCheckRun(params: CreateCheckRunParams): Promise<CheckRun>;
  updateCheckRun(checkRunId: number, params: UpdateCheckRunParams): Promise<CheckRun>;
}
```

### Event Handling

**Architecture**: Polling-based status checking via GitHub API (no webhook infrastructure in plugin layer).

The plugin polls for workflow status changes. If real-time event handling is needed, the orchestrator layer receives webhooks and publishes through the `EventBus` facet.

**Events emitted** (via EventBus facet):
- `workflow.completed` - When a workflow run finishes
- `workflow.failed` - When a workflow run fails
- `check_run.completed` - When a check run completes

### Integration Points

| Workflow Phase | GitHub Actions |
|----------------|----------------|
| After PR created | Run CI checks |
| Tests pass | Update PR status |
| Tests fail | Report to agent |
| Ready to merge | Run deployment |

### Configuration

**Authentication**: Token-only (Personal Access Token). GitHub App auth can be added at the Latency base plugin level in future.

```typescript
interface GitHubActionsConfig {
  owner: string;
  repo: string;
  token: string;  // Personal Access Token
  workflows: {
    ci?: string;                   // CI workflow filename
    deploy?: string;               // Deploy workflow filename
    test?: string;                 // Test workflow filename
  };
  polling?: {
    interval?: number;             // Polling interval in ms (default: 10000)
    maxAttempts?: number;          // Max polling attempts (default: 60)
  };
}
```

### Plugin Manifest

```typescript
{
  name: '@generacy-ai/generacy-plugin-github-actions',
  extends: 'latency-plugin-github-actions',
  provides: ['GitHubActions'],
  requires: [
    { facet: 'EventBus' },
    { facet: 'IssueTracker', optional: true }  // For status linking
  ]
}
```

## Acceptance Criteria

- [ ] Can trigger workflows via `triggerWorkflow()` and `triggerWorkflowDispatch()`
- [ ] Run status monitoring works via polling
- [ ] Log fetching works (batch mode via `getJobLogs()`)
- [ ] Artifact download works via `downloadArtifact()`
- [ ] Check run integration works via `createCheckRun()` and `updateCheckRun()`
- [ ] Events emitted via EventBus on workflow completion/failure
- [ ] Optional IssueTracker integration for status linking

## User Stories

### US1: Trigger CI Workflow

**As a** developer agent,
**I want** to trigger CI workflows programmatically,
**So that** I can run tests and checks on code changes.

**Acceptance Criteria**:
- [ ] Can trigger workflow by filename
- [ ] Can pass workflow inputs
- [ ] Receives workflow run ID for monitoring

### US2: Monitor Workflow Status

**As a** developer agent,
**I want** to monitor workflow run status,
**So that** I can react to test results and failures.

**Acceptance Criteria**:
- [ ] Can poll for workflow status updates
- [ ] Receives events when workflows complete or fail
- [ ] Can access job logs after completion

### US3: Integrate with Issue Tracking

**As a** developer agent,
**I want** workflow results linked to issues,
**So that** status is visible in the issue tracker.

**Acceptance Criteria**:
- [ ] Comments posted to issues when workflows complete (if IssueTracker available)
- [ ] Works with any IssueTracker provider (GitHub, Jira, Linear)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend latency-plugin-github-actions | P1 | Inheritance pattern |
| FR-002 | Polling-based status monitoring | P1 | No webhook infrastructure |
| FR-003 | Batch log fetching | P1 | Via getJobLogs() |
| FR-004 | Event emission via EventBus | P1 | workflow.completed, workflow.failed |
| FR-005 | Optional IssueTracker integration | P2 | Facet-based, not direct import |
| FR-006 | Token-based authentication | P1 | PAT only for now |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workflow trigger success | 99% | API call success rate |
| SC-002 | Status poll latency | <30s | Time to detect completion |
| SC-003 | Event emission | 100% | All completions emit events |

## Assumptions

- Latency `latency-plugin-github-actions` base plugin exists and is functional
- GitHub API rate limits are sufficient for polling interval
- EventBus facet is available in the runtime environment

## Out of Scope

- Webhook-based event handling (belongs in orchestrator layer)
- GitHub App authentication (future enhancement at Latency layer)
- Real-time log streaming (future enhancement via separate method)
- Direct plugin-to-plugin imports (use facet abstraction instead)

---

*Generated by speckit*
