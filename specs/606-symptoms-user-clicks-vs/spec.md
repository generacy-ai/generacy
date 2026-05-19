# Bug Fix: vscode-tunnel-manager `CONNECTED_PATTERN` doesn't match `code` 1.95.3 output

**Branch**: `606-symptoms-user-clicks-vs` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

After a user authorizes VS Code tunnel access at `github.com/login/device`, the tunnel dialog stays stuck on "Waiting for authorization..." indefinitely. The `CONNECTED_PATTERN` regex in `VsCodeTunnelProcessManager` doesn't match the actual `code` CLI 1.95.3 output (`"Open this link in your browser https://vscode.dev/tunnel/<name>/..."`) so the manager never transitions to `connected` state. Additionally, if the `code tunnel` process exits while in `authorization_pending` or `starting` state, no event is emitted — leaving the cloud dialog stranded with no signal.

## Root Cause

`packages/control-plane/src/services/vscode-tunnel-manager.ts:40`:

```typescript
const CONNECTED_PATTERN = /is connected|tunnel is ready/i;
```

The `code` CLI 1.95.3 emits `"Open this link in your browser https://vscode.dev/tunnel/<name>/workspaces"` when the tunnel is ready. This doesn't match the pattern. The manager stays in `authorization_pending` forever.

Secondary: the `exit` handler (line 102-119) only emits a `disconnected` event if the process was previously `connected`. If it exits during `starting` or `authorization_pending`, no event is emitted and the dialog has no way to know.

## User Stories

### US1: User completes VS Code tunnel authorization

**As a** developer using the Generacy wizard,
**I want** the tunnel dialog to transition to "Open in VS Code Desktop" after I authorize at GitHub,
**So that** I can open my workspace in VS Code Desktop without manual intervention.

**Acceptance Criteria**:
- [ ] After GitHub device-code authorization, `connected` event fires within ~2s
- [ ] Dialog transitions from "Waiting for authorization..." to "Open in VS Code Desktop" mode

### US2: User sees error when tunnel process fails unexpectedly

**As a** developer using the Generacy wizard,
**I want** to see an error message if the tunnel process exits before connecting,
**So that** I know something went wrong instead of waiting indefinitely.

**Acceptance Criteria**:
- [ ] If `code tunnel` exits during `starting` or `authorization_pending`, an `error` event is emitted
- [ ] Error event includes exit code and recent stdout for diagnostics

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Update `CONNECTED_PATTERN` to match `code` CLI 1.95.3 output (the `https://vscode.dev/tunnel/<name>/` URL) | P1 | Use URL-based pattern for durability; keep old alternatives as fallback |
| FR-002 | Emit `error` event on unexpected exit during `starting` or `authorization_pending` states | P1 | Include exit code and last 20 stdout lines in event payload |
| FR-003 | Extract tunnel URL from `connected` stdout line and include in event if available | P2 | Useful for cloud UI deep linking |

## Fix

### Primary: update `CONNECTED_PATTERN` (FR-001)

```diff
- const CONNECTED_PATTERN = /is connected|tunnel is ready/i;
+ const CONNECTED_PATTERN = /https:\/\/vscode\.dev\/tunnel\/[\w-]+|is connected|tunnel is ready/i;
```

The `https://vscode.dev/tunnel/<name>/` URL is the durable signal Microsoft maintains. Old alternatives kept for graceful degradation if future CLI versions change wording.

### Secondary: emit `error` on unexpected exit (FR-002)

In the `child.on('exit')` handler, add a branch for `authorization_pending` and `starting` states:

```typescript
child.on('exit', (code) => {
  const wasConnected = this.status === 'connected';
  const wasPending = this.status === 'authorization_pending' || this.status === 'starting';
  this.child = null;
  this.clearDeviceCodeTimer();
  this.deviceCode = null;
  this.verificationUri = null;

  if (wasConnected) {
    this.status = 'disconnected';
    emitTunnelEvent({ status: 'disconnected', tunnelName: this.opts.tunnelName });
  } else if (wasPending) {
    this.status = 'error';
    const last20 = this.stdoutBuffer.slice(-20).join('\n');
    emitTunnelEvent({
      status: 'error',
      error: `code tunnel exited (code ${code}) before reaching connected state`,
      details: last20 || undefined,
      tunnelName: this.opts.tunnelName,
    });
  } else {
    this.status = 'stopped';
  }

  const waiters = this.exitWaiters;
  this.exitWaiters = [];
  for (const w of waiters) w();
});
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `connected` event fires after user authorizes tunnel | Within ~2s of authorization | Manual test: bootstrap → authorize → observe event |
| SC-002 | `error` event fires on unexpected exit | Always when exiting from `starting`/`authorization_pending` | Unit test: kill process mid-auth, assert error event |
| SC-003 | Zero references to stale-only pattern | No code path relies solely on `is connected\|tunnel is ready` | Code review |

## Test Plan

- [ ] Fresh project bootstrap → wizard completes → auto-start fires → user authorizes at github.com/login/device → `connected` event fires within ~2s → dialog transitions to "Open in VS Code Desktop" mode
- [ ] Unit test: feed the manager the exact `code tunnel` 1.95.3 stdout transcript (multi-line, with the device code + "Open this link" line), assert correct status transitions
- [ ] Regression: kill `code tunnel` mid-authorization → manager emits `error` event with stdout details (instead of silent `stopped`)

## Affected Files

- `packages/control-plane/src/services/vscode-tunnel-manager.ts` — Primary fix location (pattern + exit handler)

## Related

- #584 (introduced the pattern — wasn't tested against actual `code` CLI output)
- #604 (manager state machine re-emit fix — complements this fix)
- generacy-ai/cluster-base#26 (`code` CLI install — if bundled version changes, pattern may need re-verification)

## Assumptions

- The `https://vscode.dev/tunnel/<name>/` URL format is a stable Microsoft contract
- `code` CLI 1.95.3 is the version in the current cluster-base image

## Out of Scope

- Changing `code` CLI version in cluster-base
- Cloud-side dialog UI changes (existing `connected` event handling suffices)
- Tunnel auto-reconnect logic

---

*Generated by speckit*
