# Feature Specification: Real-time Job Progress View with Phase/Step Detail

**Branch**: `179-parent-epic-part-175` | **Date**: 2026-02-23 | **Status**: Draft
**Parent Epic**: #175 — Real-time workflow monitoring
**Dependencies**: #176 (Orchestrator SSE endpoint), #177 (Worker event forwarding)

## Summary

Replace the current polling-based queue tree view with a real-time job progress view that shows phase-by-phase, step-by-step execution detail as it happens. The extension already has local execution UI (`OutputChannel`, `StatusBar`) that handles executor events well — this feature brings that same level of detail to remote/cloud jobs by leveraging the existing SSE infrastructure and webview patterns.

## Current State

The extension has a `QueueTreeProvider` (`views/cloud/queue/provider.ts`) that already subscribes to SSE queue channel events and polls the orchestrator every 30 seconds as a fallback. It shows jobs with status, priority, and grouping modes (flat, byStatus, byRepository, byAssignee), but has:
- No detail about which phase/step is currently executing
- No timing information (elapsed, estimated remaining)
- No progress indicators (phase X of Y)
- No drill-down into job execution detail

The extension also has a `WorkItemDetailPanel` (`views/cloud/queue/detail-panel.ts`) that shows basic queue item metadata (status, priority, timeline) but no phase/step execution progress.

## User Stories

### US1: Monitor Cloud Job Progress in Real-Time

**As a** developer running workflows in the cloud,
**I want** to see real-time phase and step progress for each job,
**So that** I know exactly what my job is doing without having to poll or check the orchestrator directly.

**Acceptance Criteria**:
- [ ] Queue tree view updates immediately when job status changes (no 30s polling delay)
- [ ] Each running job shows current phase (e.g., "Phase 5/8: implementation") in the tree
- [ ] Each running job shows elapsed time in the tree item description
- [ ] Status icons are color-coded: running=spinner, completed=green check, failed=red X, pending=clock

### US2: View Detailed Phase/Step Breakdown for a Job

**As a** developer investigating job execution,
**I want** to click a job and see its full phase/step progress breakdown,
**So that** I can understand what has completed, what is currently running, and what remains.

**Acceptance Criteria**:
- [ ] Clicking a job in the tree opens a webview panel showing all phases with their status
- [ ] Each phase shows its steps when expanded
- [ ] Running phases/steps show live-updating elapsed time
- [ ] Completed phases/steps show green checkmark with total duration
- [ ] Failed steps show red X with inline error message
- [ ] The webview updates in real-time via SSE without manual refresh

### US3: Track Running Jobs from the Status Bar

**As a** developer multitasking across files,
**I want** to see how many cloud jobs are currently running from the status bar,
**So that** I can stay aware of background job activity without switching views.

**Acceptance Criteria**:
- [ ] Status bar shows count of running cloud jobs (e.g., "$(cloud) 3 jobs")
- [ ] Clicking the status bar item reveals the queue tree view
- [ ] Status bar hides when no cloud jobs are active

### US4: Navigate to Pull Request from Completed Job

**As a** developer waiting for a workflow to create a PR,
**I want** to click a link in the job detail view when the PR is created,
**So that** I can immediately review the result.

**Acceptance Criteria**:
- [ ] When pr-creation phase completes, a PR link appears in the job detail webview
- [ ] Clicking the link opens the PR URL in the default browser

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Enhance `QueueTreeItem` to display phase progress (e.g., "Phase 3/8") in description | P1 | Extend existing `tree-item.ts` |
| FR-002 | Enhance `QueueTreeItem` to display elapsed time for running jobs | P1 | Use 1s timer for live updates |
| FR-003 | Add color-coded `ThemeIcon` for job status (running=sync~spin, completed=check, failed=error, pending=clock, cancelled=stop) | P1 | Follow existing `STATUS_ICONS` pattern from `status-bar.ts` |
| FR-004 | Subscribe to `workflows` SSE channel for phase/step progress events | P1 | Extend existing SSE subscription in `QueueTreeProvider` |
| FR-005 | Create new `JobDetailPanel` webview for phase/step drill-down | P1 | Follow `WorkItemDetailPanel` singleton preview/pin pattern |
| FR-006 | Render phase list in `JobDetailPanel` with status icons, names, and durations | P1 | See wireframe in issue |
| FR-007 | Render step list nested under each phase with expand/collapse | P1 | Implementation phase may have many sub-tasks |
| FR-008 | Subscribe `JobDetailPanel` to job-specific SSE events for real-time updates | P1 | Filter `workflows` channel events by jobId |
| FR-009 | Show live-updating elapsed time for running phases/steps in the webview | P1 | JavaScript `setInterval` in webview, 1s tick |
| FR-010 | Show error messages inline for failed steps in the detail webview | P1 | Red background section with error text |
| FR-011 | Add cloud job count to status bar | P2 | New status bar item alongside existing execution status bar |
| FR-012 | Click status bar job count to reveal queue tree view | P2 | `vscode.commands.executeCommand('generacy.queue.focus')` |
| FR-013 | Show PR link in detail webview when pr-creation phase completes | P2 | Open external URL on click |
| FR-014 | Show estimated time remaining based on historical phase durations | P3 | Requires orchestrator to provide estimates; fallback to "calculating" |
| FR-015 | Maintain existing polling fallback for SSE reconnection gaps | P1 | Keep 30s polling as data integrity check |

## Technical Design

### Files to Modify

| File | Change | Notes |
|------|--------|-------|
| `packages/generacy-extension/src/views/cloud/queue/provider.ts` | Add `workflows` channel SSE subscription for phase/step events; add 1s timer for elapsed time updates | Existing `queue` channel subscription stays for item add/remove/update |
| `packages/generacy-extension/src/views/cloud/queue/tree-item.ts` | Extend `QueueTreeItem` with phase progress, elapsed time, and new status icons | |
| `packages/generacy-extension/src/api/types.ts` | Add `JobProgress`, `PhaseProgress`, `StepProgress` types and Zod schemas | |
| `packages/generacy-extension/src/providers/status-bar.ts` | Add second status bar item for cloud job count | Keep separate from local execution status bar |
| `packages/generacy-extension/src/constants.ts` | Add new view IDs and command IDs for job detail | |

### New Files

| File | Purpose | Notes |
|------|---------|-------|
| `packages/generacy-extension/src/views/cloud/job-detail/panel.ts` | `JobDetailPanel` — webview panel manager with preview/pin pattern | Follow `WorkItemDetailPanel` pattern |
| `packages/generacy-extension/src/views/cloud/job-detail/webview.ts` | HTML generation for job detail webview | Follow `dashboard/webview.ts` pattern; CSP-compliant with nonces |

### New Types

```typescript
/** Progress data for a job (extends QueueItem) */
interface JobProgress {
  jobId: string;
  phases: PhaseProgress[];
  currentPhaseIndex: number;
  totalPhases: number;
  startedAt?: string;
  estimatedRemainingMs?: number;
}

/** Progress data for a single phase */
interface PhaseProgress {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  steps: StepProgress[];
}

/** Progress data for a single step within a phase */
interface StepProgress {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  output?: string;
  /** PR URL if this is a pr-creation step */
  prUrl?: string;
}
```

### SSE Event Flow

1. `QueueTreeProvider` already subscribes to `queue` channel for item-level events
2. Add subscription to `workflows` channel for phase/step progress events
3. Events from `workflows` channel include:
   - `workflow:phase:start` — phase began executing
   - `workflow:phase:complete` — phase finished (success or failure)
   - `workflow:step:start` — step began executing
   - `workflow:step:complete` — step finished (success or failure)
   - `workflow:progress` — periodic progress update with full phase/step state
4. `JobDetailPanel` filters `workflows` events by `jobId` to update its display
5. `QueueTreeProvider` uses `workflow:progress` events to update tree item descriptions

### Webview Communication

The `JobDetailPanel` webview uses the standard VS Code message protocol:

**Extension to Webview**:
- `{ type: 'update', progress: JobProgress }` — full progress state update
- `{ type: 'phaseUpdate', phase: PhaseProgress, index: number }` — incremental phase update
- `{ type: 'stepUpdate', step: StepProgress, phaseIndex: number, stepIndex: number }` — incremental step update

**Webview to Extension**:
- `{ type: 'ready' }` — webview loaded, send initial data
- `{ type: 'refresh' }` — user requested manual refresh
- `{ type: 'pin' }` — pin this panel
- `{ type: 'openPR', url: string }` — open PR in browser
- `{ type: 'togglePhase', phaseIndex: number }` — expand/collapse phase detail

### Elapsed Time Updates

Two timer mechanisms:
1. **Tree view**: 1s `setInterval` in `QueueTreeProvider` fires `_onDidChangeTreeData` when any job is `running`, so elapsed times in the tree refresh live. Timer stops when no jobs are running.
2. **Webview**: JavaScript `setInterval(1000)` inside the webview updates displayed elapsed times client-side without requiring extension-to-webview messages every second.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time from status change to UI update | < 2 seconds | Measure delay between SSE event arrival and tree item / webview re-render |
| SC-002 | Tree view elapsed time accuracy | Within 1 second of real time | Compare displayed elapsed time to `Date.now() - startedAt` |
| SC-003 | Webview initial load time | < 500ms from click to rendered content | Timestamp from command execution to `ready` message |
| SC-004 | Memory usage with 50 concurrent jobs | < 20 MB incremental | Profile extension host memory before/after opening 50-job tree |
| SC-005 | SSE reconnection resilience | Full state recovered within 5 seconds | Disconnect SSE, verify tree and webview recover via polling fallback |
| SC-006 | No flickering on tree updates | Zero full-collapse events during SSE updates | Visual inspection; debounce timer prevents rapid refreshes |

## Assumptions

- The orchestrator SSE endpoint (#176) emits `workflow:phase:start`, `workflow:phase:complete`, `workflow:step:start`, and `workflow:step:complete` events with `jobId`, phase name, step name, and timing data
- Worker event forwarding (#177) ensures phase/step events reach the orchestrator SSE stream with < 1s latency
- The `QueueItem` API response will be extended to include a `progress` field with current phase/step summary (for initial load and polling fallback)
- The existing `SSESubscriptionManager` `workflows` channel receives job-level progress events (currently used for workflow start/complete/fail events)
- VS Code webview `retainContextWhenHidden` is acceptable for keeping the detail panel state across tab switches

## Out of Scope

- **Log streaming**: Showing full execution logs (stdout/stderr) for individual steps in the detail webview (could be a follow-up with OutputChannel integration)
- **Job cancellation from detail view**: Cancelling a running job from the webview (can use existing queue action commands)
- **Multi-job comparison**: Side-by-side comparison of multiple job executions
- **Historical job browsing**: Viewing completed/failed jobs from past sessions (requires API support)
- **Notification preferences**: User configuration for which job events trigger VS Code notifications
- **Custom theme support**: Beyond VS Code theme variable integration (which is inherited automatically)
- **Job detail for local executions**: This feature is scoped to cloud/remote jobs only; local execution already has `OutputChannel` + `StatusBar` UI

---

*Generated by speckit*
