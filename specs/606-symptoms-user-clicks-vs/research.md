# Research: vscode-tunnel-manager CONNECTED_PATTERN Fix

**Feature**: #606 | **Date**: 2026-05-12

## Problem Analysis

### Current Behavior

`VsCodeTunnelProcessManager` parses `code tunnel` stdout line-by-line looking for state transitions. The `CONNECTED_PATTERN` at line 40:

```typescript
const CONNECTED_PATTERN = /is connected|tunnel is ready/i;
```

This was introduced in #584 but never tested against actual `code` CLI output. The real `code` CLI 1.95.3 emits:

```
* Visual Studio Code Server
*
* By using the software, you agree to
* the Visual Studio Code Server License Terms (https://aka.ms/vscode-server-license) and
* the Microsoft Privacy Statement (https://privacy.microsoft.com/en-us/privacystatement).
*
To grant access to the server, please log into https://github.com/login/device and use code ABCD-1234
Open this link in your browser https://vscode.dev/tunnel/my-cluster/workspaces
```

The "connected" signal is the `https://vscode.dev/tunnel/<name>/` URL line — neither `is connected` nor `tunnel is ready` appears.

### Secondary Issue

The `exit` handler only emits a `disconnected` event if the process was previously `connected`. If exit occurs during `starting` or `authorization_pending`, the status silently becomes `stopped` with no event — leaving the cloud dialog stranded.

## Pattern Alternatives Considered

| Pattern | Pros | Cons | Decision |
|---------|------|------|----------|
| `/https:\/\/vscode\.dev\/tunnel\//i` | Matches URL directly | No name capture | Rejected — less useful |
| `/https:\/\/vscode\.dev\/tunnel\/[\w-]+/i` | Captures tunnel name segment | Slightly complex regex | **Selected** — durable, captures useful data |
| `/Open this link in your browser/i` | Matches UI text | Fragile to wording changes | Rejected |
| `/vscode\.dev/i` | Very broad | False positives on other vscode.dev URLs | Rejected |

## URL Extraction (FR-003)

For the `tunnelUrl` field, a separate capture pattern extracts the full URL:

```typescript
const TUNNEL_URL_PATTERN = /(https:\/\/vscode\.dev\/tunnel\/[\w-]+[\w\-/]*)/;
```

This captures the full path (e.g., `https://vscode.dev/tunnel/my-cluster/workspaces`) for deep linking.

## Exit Handler Design

The exit handler needs to distinguish three exit scenarios:

1. **Was connected** → emit `disconnected` (existing behavior, preserved)
2. **Was pending/starting** → emit `error` with exit code + stdout tail (new)
3. **Was stopped/stopping** → set `stopped`, no event (existing behavior, preserved)

The `code` parameter from Node.js `exit` event can be `null` (signal kill), so the error message should handle both cases.

## Key Sources

- #584: Original `VsCodeTunnelProcessManager` implementation
- #604: Manager state machine re-emit fix (complementary)
- VS Code CLI source: tunnel output format is defined in the `code` binary, not publicly documented as a stable API
- `https://vscode.dev/tunnel/<name>/` URL format: used by VS Code web client, stable across versions
