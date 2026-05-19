# Bug Fix: Control-plane relay event IPC channel

Control-plane process never wires `setRelayPushEvent()` — all relay events from control-plane are silently dropped

**Branch**: `594-symptoms-after-clicking-vs` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

The control-plane process emits relay events (`cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`) via `getRelayPushEvent()`, but nothing ever calls `setRelayPushEvent()` to wire it up. Since control-plane and orchestrator are separate processes (no shared memory), events are silently dropped. The fix establishes an HTTP-based IPC channel: control-plane POSTs events to a new orchestrator endpoint (`POST /internal/relay-events`), which forwards them via the existing relay client. Authentication uses a shared ephemeral API key generated at container boot.

## Symptoms

After clicking "VS Code Desktop" → "Start tunnel" in the bootstrap wizard, the dialog spins forever. The cluster IS spawning \`code tunnel\` correctly (verified via \`docker exec\`), but the device code never reaches the frontend.

Verified on a live cluster (\`onboarding-test-5\`):
\`\`\`
$ docker exec <orchestrator> ps aux | grep tunnel
node 913 /usr/local/bin/code tunnel --accept-server-license-terms --name <id>   ✓ running
\`\`\`

Cloud's \`cluster:vscode-tunnel\` SSE channel never fires. Frontend's [\`use-vscode-tunnel.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/lib/hooks/use-vscode-tunnel.ts) listener gets nothing.

## Root cause

The control-plane process has the event emission code wired correctly:

\`\`\`typescript
// packages/control-plane/src/services/vscode-tunnel-manager.ts:52-55
function emitTunnelEvent(payload: VsCodeTunnelEvent): void {
  const pushEvent = getRelayPushEvent();
  if (pushEvent) pushEvent('cluster.vscode-tunnel', payload);
}
\`\`\`

But \`getRelayPushEvent()\` returns \`undefined\` because **nothing ever calls \`setRelayPushEvent()\`** anywhere in the control-plane process. Verified:

\`\`\`
$ grep -r 'setRelayPushEvent' packages/control-plane/bin/ packages/orchestrator/src/
# packages/control-plane/bin/control-plane.ts → zero references
# packages/orchestrator/src/* → zero references
# Only the definition + a re-export from audit.ts
\`\`\`

The control-plane is a separate process from the orchestrator. They don't share memory. The orchestrator owns the \`cluster-relay\` client (the only thing that can talk to the cloud relay), but the control-plane process has no IPC channel back to it. Every \`emitTunnelEvent\`, \`pushEvent('cluster.credentials', ...)\`, \`pushEvent('cluster.audit', ...)\` call evaluates the \`if (pushEvent)\` guard to false and silently no-ops.

## Scope — three event types affected

| Event | Source | Symptom of being dropped |
|---|---|---|
| \`cluster.vscode-tunnel\` | [\`vscode-tunnel-manager.ts:52\`](packages/control-plane/src/services/vscode-tunnel-manager.ts#L52) | "Start Tunnel" UI spins; the immediate trigger for this issue |
| \`cluster.audit\` | [\`audit.ts:42-46\`](packages/control-plane/src/routes/audit.ts#L42-L46) | credhelper-daemon audit batches arrive at the cluster but never leave |
| \`cluster.credentials\` | [\`credential-writer.ts:58\`](packages/control-plane/src/services/credential-writer.ts#L58) | Cloud sees no event when a credential is sealed; the wizard's "credential written" feedback is dead |

The credential and audit drops have been latent because cloud-side flows didn't depend on receiving the events. vscode-tunnel exposes the gap because the device code arrives **asynchronously** after the lifecycle action's HTTP response — only relay events can carry it back.

## Fix — establish an IPC channel from control-plane to orchestrator

Cleanest approach: control-plane HTTP-POSTs events to a new orchestrator endpoint, which forwards via the existing relay client.

### Step 1 — orchestrator exposes an internal endpoint

In [\`packages/orchestrator/src/server.ts\`](packages/orchestrator/src/server.ts), after the relay client is constructed, register:

\`\`\`typescript
server.post('/internal/relay-events', {
  preHandler: requireInternalApiKey,  // uses the shared internal key, see step 3
}, async (req, reply) => {
  const { channel, payload } = req.body as { channel: string; payload: unknown };
  relayClient.send({
    type: 'event',
    event: channel,
    data: payload,
    timestamp: new Date().toISOString(),
  });
  reply.code(204).send();
});
\`\`\`

### Step 2 — control-plane bin/control-plane.ts wires the push callback

\`\`\`typescript
import { setRelayPushEvent } from '../src/relay-events.js';

const orchestratorUrl = process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100';
const internalApiKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];

if (internalApiKey) {
  setRelayPushEvent((channel, payload) => {
    fetch(\`\${orchestratorUrl}/internal/relay-events\`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': \`Bearer \${internalApiKey}\`,
      },
      body: JSON.stringify({ channel, payload }),
    }).catch((err) => {
      console.error('[control-plane] Failed to push relay event:', err.message);
    });
  });
} else {
  console.warn('[control-plane] ORCHESTRATOR_INTERNAL_API_KEY not set — relay events will be silently dropped');
}
\`\`\`

### Step 3 — entrypoint generates the shared key

In [\`cluster-base/.devcontainer/generacy/scripts/entrypoint-orchestrator.sh\`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/entrypoint-orchestrator.sh), before the control-plane spawn:

\`\`\`bash
export ORCHESTRATOR_INTERNAL_API_KEY="$(uuidgen)"
# control-plane reads it from env at spawn time
"${SHARED_PACKAGES}/node_modules/.bin/control-plane" >>"\${CONTROL_PLANE_LOG}" 2>&1 &
# orchestrator inherits via the export
exec generacy orchestrator ...
\`\`\`

The orchestrator's existing \`apiKeyStore\` already supports adding ephemeral keys at boot (see the \`relayInternalKey\` pattern around server.ts:628). Add this new key the same way and use it to authorize \`/internal/relay-events\`.

This is a companion change in cluster-base — file alongside.

## Test plan
- [ ] After fix: clicking "Start Tunnel" produces an SSE event \`cluster:vscode-tunnel\` with \`status: 'starting'\` within ~100ms (cluster → orchestrator → relay → cloud → SSE)
- [ ] Device code appears in the dialog within ~5s
- [ ] Audit log entries from credhelper-daemon reach \`organizations/{orgId}/clusters/{clusterId}/audit_log\` in Firestore
- [ ] \`cluster.credentials\` events fire when the wizard writes credentials
- [ ] No regression: code-server's separate \`onStatusChange\` callback (per #586) still triggers \`sendMetadata\` on the relay-bridge directly (not through this new path)

## Related
- generacy-ai/generacy-cloud#543 (fixed the cloud-side event-name filter — necessary, but the cluster side never sends anything for it to filter on)
- generacy-ai/generacy#584 (added vscode-tunnel-manager — emits events through the broken pipe)
- generacy-ai/generacy#572 (cluster ↔ cloud contract umbrella)

## Diagnostic context

\`\`\`
$ grep -rn "setRelayPushEvent" packages/control-plane/ packages/orchestrator/
packages/control-plane/src/relay-events.ts:6:export function setRelayPushEvent(fn: PushEventFn): void {
packages/control-plane/src/routes/audit.ts:10:export { setRelayPushEvent, type PushEventFn } from '../relay-events.js';
# definition + one re-export, no call sites
\`\`\`

## User Stories

### US1: VS Code tunnel device code delivery

**As a** developer using the bootstrap wizard,
**I want** the "Start Tunnel" button to display the device code for VS Code tunnel auth,
**So that** I can complete VS Code Desktop setup without manual container inspection.

**Acceptance Criteria**:
- [ ] Clicking "Start Tunnel" produces `cluster:vscode-tunnel` SSE event with `status: 'starting'` within ~100ms
- [ ] Device code appears in the wizard dialog within ~5s of tunnel process startup
- [ ] `authorization_pending` event includes both `deviceCode` and `verificationUri`

### US2: Credential write feedback

**As a** developer completing the bootstrap wizard,
**I want** the cloud UI to receive confirmation when credentials are sealed,
**So that** the wizard can advance steps without polling.

**Acceptance Criteria**:
- [ ] `cluster.credentials` events fire when the wizard writes credentials via `PUT /credentials/:id`
- [ ] Events contain `credentialId`, `type`, and `status: 'written'`

### US3: Audit log delivery

**As a** platform operator,
**I want** credhelper-daemon audit batches to reach cloud Firestore,
**So that** credential usage is observable and auditable.

**Acceptance Criteria**:
- [ ] Audit entries from credhelper-daemon reach `organizations/{orgId}/clusters/{clusterId}/audit_log`
- [ ] No entries are silently dropped under normal operation

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Orchestrator exposes `POST /internal/relay-events` endpoint | P0 | Accepts `{ channel, payload }`, forwards via relay client |
| FR-002 | Endpoint authenticates via `ORCHESTRATOR_INTERNAL_API_KEY` bearer token | P0 | Uses existing `apiKeyStore` pattern |
| FR-003 | `control-plane.ts` entry point calls `setRelayPushEvent()` with HTTP callback | P0 | Fire-and-forget POST to orchestrator |
| FR-004 | Entrypoint script generates ephemeral UUID key shared by both processes | P0 | Companion change in cluster-base repo |
| FR-005 | Graceful degradation: if key is not set, log warning and continue | P1 | Existing `if (pushEvent)` guards remain |
| FR-006 | Channel name allowlist on orchestrator endpoint | P2 | Prevent arbitrary event injection; accept `cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | VS Code tunnel event latency | < 200ms cluster-to-cloud | Timestamp diff between `emitTunnelEvent` call and SSE receipt |
| SC-002 | Zero dropped relay events | 0 silent drops under normal operation | `getRelayPushEvent()` returns a function in control-plane process |
| SC-003 | No regression on code-server metadata | `codeServerReady` still propagates via relay-bridge `sendMetadata` | Existing #586 `onStatusChange` path unaffected |
| SC-004 | Zero `setRelayPushEvent` references remain as dead code | All 3 event channels functional | Grep verification + integration test |

## Assumptions

- Control-plane and orchestrator always run in the same container (localhost networking)
- The orchestrator's HTTP server is listening before control-plane attempts its first event POST
- `ORCHESTRATOR_INTERNAL_API_KEY` env var is the secure channel (process-level isolation, not network-level)
- Cluster-base companion PR will be merged alongside this change

## Out of Scope

- Cloud-side SSE delivery changes (already wired in generacy-cloud#543)
- Replacing the HTTP IPC with Unix domain socket or named pipe
- Retry/queue semantics for the control-plane→orchestrator POST (fire-and-forget is sufficient)
- Post-bootstrap credential edit cache reload (separate issue)

---

*Generated by speckit*
