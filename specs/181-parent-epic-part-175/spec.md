# Feature Specification: Job Completion Notifications and Error Alerts

Part of #175 — Real-time workflow monitoring

**Branch**: `181-parent-epic-part-175` | **Date**: 2026-02-23 | **Status**: Draft

## Summary

Add proactive notifications when remote cloud jobs complete, fail, or encounter errors. Currently, users have no feedback when a job finishes — they must manually check the queue view. This feature introduces VS Code notification toasts with contextual action buttons ("View PR", "View Logs", "View Details") and enhances the status bar to reflect real-time cloud job state, giving users immediate awareness of job outcomes without leaving their current task.

## User Stories

### US1: Successful Job Completion

**As a** developer running workflows in the cloud,
**I want** to be notified when a job completes successfully,
**So that** I can immediately review the resulting PR or move on to the next task.

**Acceptance Criteria**:
- [ ] An information notification appears when a cloud job reaches `completed` status
- [ ] The notification displays the workflow name and total elapsed duration
- [ ] If a PR was created, the notification includes the PR number and title
- [ ] A "View PR" action button opens the PR URL in the default browser
- [ ] A "View Details" action button opens the job detail panel (from #179)

### US2: Job Failure

**As a** developer running workflows in the cloud,
**I want** to be alerted when a job fails,
**So that** I can diagnose the problem quickly and retry or fix the issue.

**Acceptance Criteria**:
- [ ] A warning notification appears when a cloud job reaches `failed` status
- [ ] The notification shows the workflow name, the step that failed, and the error summary
- [ ] A "View Logs" action button opens the job detail panel scrolled to the error
- [ ] A "View Details" action button opens the job detail panel

### US3: Non-Interrupting Step Failure

**As a** developer running a workflow with `continueOnError` steps,
**I want** step failures to be surfaced subtly,
**So that** I'm aware of issues without being interrupted during deep work.

**Acceptance Criteria**:
- [ ] When a step fails but the job continues (`continueOnError`), no toast notification is shown
- [ ] The status bar briefly flashes a warning indicator
- [ ] The status bar tooltip includes the step failure summary

### US4: Job Cancellation

**As a** developer who cancelled a cloud job,
**I want** confirmation that the cancellation took effect,
**So that** I know the job is no longer consuming resources.

**Acceptance Criteria**:
- [ ] An information notification appears when a cloud job reaches `cancelled` status
- [ ] The notification displays the workflow name and how long it ran before cancellation

### US5: Notification Configuration

**As a** developer who finds notifications distracting,
**I want** to configure which notifications I receive,
**So that** I can tailor the experience to my workflow preferences.

**Acceptance Criteria**:
- [ ] A master toggle `generacy.notifications.enabled` disables all notifications when set to `false`
- [ ] `generacy.notifications.onComplete` independently controls success notifications
- [ ] `generacy.notifications.onError` independently controls failure notifications
- [ ] `generacy.notifications.sound` enables an audible alert on job completion/failure
- [ ] Configuration changes take effect immediately without restart

### US6: Status Bar Job Awareness

**As a** developer with cloud jobs running,
**I want** to see the current job count and latest status at a glance in the status bar,
**So that** I have continuous passive awareness of cloud activity.

**Acceptance Criteria**:
- [ ] The status bar shows the count of currently running cloud jobs
- [ ] The status bar briefly animates when a job completes or fails
- [ ] Clicking the status bar item focuses the queue tree view
- [ ] The status bar tooltip shows a summary of recent completions/failures

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Subscribe to `queue` SSE channel for `queue:item:updated` events with terminal statuses (`completed`, `failed`, `cancelled`) | P1 | Reuse existing `SSESubscriptionManager` infrastructure |
| FR-002 | Show VS Code information notification on job completion with workflow name, duration, and optional PR info | P1 | Use `vscode.window.showInformationMessage` |
| FR-003 | Show VS Code warning notification on job failure with workflow name, failed step, and error summary | P1 | Use `vscode.window.showWarningMessage` |
| FR-004 | Provide "View PR" action button that opens the PR URL via `vscode.env.openExternal` | P1 | Only shown when `prUrl` is present in event data |
| FR-005 | Provide "View Logs" action button that opens the job detail panel focused on the error | P1 | Executes `generacy.queue.viewProgress` command with job ID |
| FR-006 | Provide "View Details" action button on all terminal notifications | P2 | Executes `generacy.queue.viewProgress` command with job ID |
| FR-007 | Suppress toast notifications for `continueOnError` step failures; reflect in status bar only | P2 | Check step metadata for `continueOnError` flag |
| FR-008 | Show information notification on job cancellation with workflow name and elapsed time | P2 | |
| FR-009 | Register `generacy.notifications.enabled` configuration setting (default: `true`) | P1 | Add to `package.json` contributes.configuration |
| FR-010 | Register `generacy.notifications.onComplete` configuration setting (default: `true`) | P1 | Gated by master toggle |
| FR-011 | Register `generacy.notifications.onError` configuration setting (default: `true`) | P1 | Gated by master toggle |
| FR-012 | Register `generacy.notifications.sound` configuration setting (default: `false`) | P3 | Uses VS Code accessibility sound API if available |
| FR-013 | Enhance `CloudJobStatusBarProvider` to flash/animate on job completion or failure | P2 | Brief icon/color change, revert after 3-5 seconds |
| FR-014 | Update status bar tooltip to include latest completion/failure summary | P2 | Show last 3 terminal events |
| FR-015 | Deduplicate notifications — do not re-notify for events already seen (e.g., after SSE reconnection with `Last-Event-ID` replay) | P1 | Track seen event IDs in a bounded Set |
| FR-016 | Format elapsed duration as human-readable string (e.g., "31m 22s", "1h 5m") | P2 | Reuse or extract from existing status bar duration formatting |
| FR-017 | Respect notification settings changes at runtime without requiring reload | P1 | Listen to `vscode.workspace.onDidChangeConfiguration` |

## Technical Design

### Architecture

The new `NotificationManager` service in `src/services/notification-manager.ts` replaces and extends the existing `src/utils/notifications.ts`. It subscribes to the `queue` SSE channel and dispatches VS Code notifications based on event type and user configuration.

```
SSESubscriptionManager
        │
        ▼
  NotificationManager ──► vscode.window.showInformationMessage / showWarningMessage
        │
        ├──► CloudJobStatusBarProvider (status bar updates)
        └──► JobDetailPanel (via "View Details" / "View Logs" commands)
```

### Event Flow

1. SSE delivers `queue:item:updated` event with terminal status
2. `NotificationManager` checks if notifications are enabled (master + per-type toggle)
3. Deduplication check against seen event IDs
4. Build notification message with workflow name, duration, and contextual details
5. Determine action buttons based on event data (PR URL presence, failure details)
6. Show notification; handle action button clicks
7. Update `CloudJobStatusBarProvider` with flash animation and tooltip

### Notification Message Format

**Success (with PR)**:
```
speckit-bugfix completed (31m 22s) → PR #62: fix: request_decision options not displaying
[View PR] [View Details]
```

**Success (no PR)**:
```
speckit-bugfix completed (31m 22s)
[View Details]
```

**Failure**:
```
speckit-bugfix failed at step "implement" (18m 5s) — Error: Task T003 timed out
[View Logs] [View Details]
```

**Cancelled**:
```
speckit-bugfix cancelled (12m 8s)
[View Details]
```

### Configuration Schema

```jsonc
{
  "generacy.notifications.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Enable job completion and error notifications"
  },
  "generacy.notifications.onComplete": {
    "type": "boolean",
    "default": true,
    "description": "Show notification when a cloud job completes successfully"
  },
  "generacy.notifications.onError": {
    "type": "boolean",
    "default": true,
    "description": "Show notification when a cloud job fails"
  },
  "generacy.notifications.sound": {
    "type": "boolean",
    "default": false,
    "description": "Play a sound when a cloud job completes or fails"
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/generacy-extension/src/services/notification-manager.ts` | **New file.** Core notification service with SSE subscription, deduplication, configuration handling, and VS Code notification dispatch |
| `packages/generacy-extension/src/providers/status-bar.ts` | Enhance `CloudJobStatusBarProvider` with flash animation on terminal events, tooltip history of recent completions/failures |
| `packages/generacy-extension/package.json` | Add `generacy.notifications.*` configuration settings to `contributes.configuration` |
| `packages/generacy-extension/src/commands/cloud.ts` | Initialize `NotificationManager` with SSE manager reference; wire up lifecycle |
| `packages/generacy-extension/src/utils/notifications.ts` | Deprecate or remove in favor of the new `NotificationManager` service |

## Dependencies

| Dependency | Type | Status | Impact |
|-----------|------|--------|--------|
| #176 — Orchestrator SSE endpoint | Hard | Implemented (#220) | Required to receive real-time `queue:item:updated` events with terminal statuses |
| #179 — Job progress view | Soft | Implemented (#222) | Enables "View Details" and "View Logs" action buttons to open the detail panel |
| SSESubscriptionManager | Internal | Available | Existing infrastructure for SSE subscriptions |
| CloudJobStatusBarProvider | Internal | Available | Existing status bar provider to enhance |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Notification delivery latency | < 2 seconds from SSE event receipt to toast display | Timestamp delta in debug logs |
| SC-002 | Action button functionality | 100% of "View PR" clicks open the correct PR URL | Manual QA across success scenarios |
| SC-003 | Configuration responsiveness | Settings changes take effect within 1 second, no reload required | Toggle setting and verify next notification respects it |
| SC-004 | Deduplication accuracy | Zero duplicate notifications after SSE reconnection | Simulate disconnect/reconnect with `Last-Event-ID` replay |
| SC-005 | Status bar update | Running count updates within 1 second of job state change | Visual verification during integration test |
| SC-006 | User satisfaction | Notifications perceived as helpful, not disruptive | Qualitative feedback from internal testing |

## Assumptions

- The SSE `queue:item:updated` event payload includes `status`, `workflowName`, `startedAt`, `completedAt`, and optionally `prUrl`, `error`, and `failedStep` fields
- The `SSESubscriptionManager` (#176) is operational and delivers events reliably with `Last-Event-ID` replay on reconnection
- The `generacy.queue.viewProgress` command (#179) is registered and can accept a job ID to open the detail panel
- VS Code's notification API (`showInformationMessage` / `showWarningMessage`) is sufficient — no need for custom webview-based notifications
- The existing `CloudJobStatusBarProvider` can be extended in place without breaking current functionality
- Sound playback is best-effort — it depends on VS Code accessibility sound support and OS audio configuration

## Out of Scope

- Desktop/OS-level notifications (e.g., system tray popups when VS Code is minimized) — relies on VS Code's built-in notification forwarding
- Notification history panel — users can check the job queue view for historical status
- Slack, email, or webhook-based external notifications — server-side concern, not extension
- Per-workflow or per-repository notification rules — all cloud jobs use the same notification settings
- Rich notification content (images, markdown rendering) — VS Code notification API supports plain text only
- Retry action button on failure notifications — retry requires workflow re-submission which is a separate concern
- Notification grouping/stacking for batch job completions — each job gets its own notification

---

*Generated by speckit*
