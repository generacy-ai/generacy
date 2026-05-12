# Research: VS Code Tunnel Lifecycle

## Technology Decisions

### 1. Process Management: Managed child process (not systemd, not supervisor)

**Decision**: Replicate `CodeServerProcessManager` pattern — `node:child_process.spawn()` with SIGTERM/SIGKILL lifecycle.

**Rationale**:
- Containers don't run systemd as PID 1, so `code tunnel service install` requires workarounds
- Supervisor (e.g., supervisord) is overkill for a single process
- `CodeServerProcessManager` is battle-tested in this codebase and follows the same lifecycle

**Differences from CodeServerProcessManager**:
- No idle timeout (tunnels should stay alive indefinitely)
- Stdout parsing required (device code extraction)
- Relay event emission on state transitions
- No socket-based readiness check (tunnel readiness detected via stdout patterns)

### 2. Stdout Parsing: Regex with fallback

**Decision**: Line-by-line regex scan of `code tunnel` stdout.

**Rationale**:
- `code tunnel` has no `--output json` flag
- The device code format (`XXXX-XXXX`) and GitHub URL are stable across versions
- Fallback: if parsing fails after 30s, emit `error` event with raw stdout so user can still complete auth manually
- Version-pinning in cluster-base Dockerfile further reduces parsing breakage risk

**Patterns**:
- Device code: `/([A-Z0-9]{4}-[A-Z0-9]{4})/`
- Verification URI: `/https:\/\/github\.com\/login\/device/`
- Connected indicator: `/is connected|tunnel is ready/i` (to be confirmed against actual output)

### 3. Relay Events: Full lifecycle on `cluster.vscode-tunnel`

**Decision**: Emit all lifecycle transitions, not just device code.

**Rationale**:
- Web UI needs distinct UX per state: spinner (starting), code entry (authorization_pending), open button (connected), retry (error)
- Matches the `cluster.bootstrap` and `cluster.credentials` event patterns
- `authorization_pending` naming consistent with v1.5 activation terminology

**Alternative rejected**: Return device code from lifecycle action response. Rejected because device code arrives asynchronously after spawn — the lifecycle action returns before the code appears in stdout.

### 4. Auth Persistence: Named Docker volume

**Decision**: `vscode-cli:/home/node/.vscode-cli` mounted on orchestrator only.

**Rationale**:
- `generacy update` runs `docker compose down && up`, destroying container filesystem
- Without persistence, every update re-prompts for GitHub device code auth
- Volume is private to orchestrator (workers don't run tunnels)
- Matches existing volume patterns in scaffolder (workspace, npm-cache, generacy-data)

### 5. Auto-start: Bootstrap-complete trigger

**Decision**: Wire tunnel start into the existing `bootstrap-complete` lifecycle handler.

**Rationale**:
- Bootstrap-complete already runs when the cluster finishes setup
- Adding `tunnelManager.start()` there is a one-line addition
- No separate auto-start mechanism (file watcher, timer) needed
- If user hasn't authenticated yet, the `authorization_pending` event will surface the device code

**Alternative considered**: Container entrypoint auto-start. Rejected because tunnel start should be controlled by the control-plane, not hardcoded in the image.

## Implementation Patterns

### Singleton DI Pattern (from CodeServerManager)

```typescript
let manager: VsCodeTunnelManager | null = null;

export function getVsCodeTunnelManager(): VsCodeTunnelManager {
  if (!manager) manager = new VsCodeTunnelProcessManager(loadOptionsFromEnv());
  return manager;
}

export function setVsCodeTunnelManager(next: VsCodeTunnelManager | null): void {
  manager = next;
}
```

### Relay Event Emission Pattern (from peer-repo-cloner)

```typescript
function emitTunnelEvent(payload: VsCodeTunnelEvent): void {
  const pushEvent = getRelayPushEvent();
  if (pushEvent) pushEvent('cluster.vscode-tunnel', payload);
}
```

### Lifecycle Dispatch Pattern (from lifecycle.ts)

```typescript
if (parsed.data === 'vscode-tunnel-start') {
  const manager = getVsCodeTunnelManager();
  const result = await manager.start();
  res.writeHead(200);
  res.end(JSON.stringify(result));
  return;
}
```

## Key Sources

- `packages/control-plane/src/services/code-server-manager.ts` — Primary pattern reference
- `packages/control-plane/src/routes/lifecycle.ts` — Lifecycle dispatch pattern
- `packages/control-plane/src/relay-events.ts` — Event emission infrastructure
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — Volume/compose generation
- VS Code CLI tunnel docs: https://code.visualstudio.com/docs/remote/tunnels
