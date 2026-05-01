# Feature Specification: Cluster-Side IDE Tunnel Support

Clicking "Open IDE" hangs forever in "Connecting…" with no error

**Branch**: `519-context-clicking-open-ide` | **Date**: 2026-05-01 | **Status**: Draft

## Summary

Add cluster-side tunnel message handling so the cloud's `TunnelManager` can establish a bidirectional byte stream to code-server's Unix socket. This unblocks the "Open IDE" button which currently hangs in "Connecting…" because tunnel messages are silently dropped by the relay's schema validation.

## Context

Clicking "Open IDE" hangs forever in "Connecting…" with no error. Two missing pieces:
1. The cloud's `TunnelManager` sends `tunnel_open`/`tunnel_data`/`tunnel_close` messages, but the cluster's `cluster-relay` schema doesn't include these types — they're silently dropped at parse time.
2. Even if the schema accepted them, there's no code in the cluster control-plane that registers a tunnel handler, opens the Unix socket at `/run/code-server.sock`, sends `tunnel_open_ack`, or proxies `tunnel_data` bidirectionally.

## Files

- `packages/cluster-relay/src/messages.ts:177-185` — `RelayMessageSchema` discriminated union excludes tunnel types.
- `packages/cluster-relay/src/relay.ts:311-327` — only `api_request` is hardcoded-handled; nothing dispatches tunnel messages to a registered handler.
- `packages/control-plane/src/services/tunnel-handler.ts` — does NOT exist; needs to be created.

## Fix

1. **Add four tunnel message types** to `messages.ts`:
   - `TunnelOpenMessage { type: 'tunnel_open', tunnelId, target }` — target is the Unix socket path
   - `TunnelOpenAckMessage { type: 'tunnel_open_ack', tunnelId, status: 'ok' | 'error', error? }`
   - `TunnelDataMessage { type: 'tunnel_data', tunnelId, data }` — base64 bytes
   - `TunnelCloseMessage { type: 'tunnel_close', tunnelId, reason? }`
   - Add Zod schemas and include in `RelayMessageSchema` discriminated union.
2. **Register dispatch in cluster-relay client** so tunnel messages route to a registered handler (similar to the existing `messageHandlers` array dispatch path).
3. **Implement `packages/control-plane/src/services/tunnel-handler.ts`**:
   - Accepts a `RelayMessageSender` interface (`send(message): Promise<void>`) via constructor injection; orchestrator passes `relay.send.bind(relay)` at boot (per Q1).
   - On `tunnel_open`: restrict `target` to `/run/code-server.sock` only — reject any other path with `tunnel_open_ack { status: 'error', error: 'invalid target' }` (per Q3). Auto-start code-server via `CodeServerManager.start()` if not running, with 10s timeout (per Q2). On success send `tunnel_open_ack { status: 'ok' }`; on error send `{ status: 'error', error }`.
   - On `tunnel_data`: forward bytes bidirectionally between socket and relay. Reset code-server idle timer via `CodeServerManager.touch()` on each inbound `tunnel_data` for code-server tunnels (per Q5).
   - On `tunnel_close`: close the socket and clean up.
   - Handle abrupt disconnects (socket closed without explicit `tunnel_close`).
   - Cluster-side is stateless across relay reconnects — cloud re-sends `tunnel_open` for active sessions (per Q4).
4. **Wire handler at control-plane startup** so it's active when the cluster boots. Orchestrator passes relay send callback at boot time.

## Acceptance criteria

- "Open IDE" button on the bootstrap Ready screen opens a working code-server in a new tab.
- Tunnel survives 30+ minutes of editor activity.
- Relay disconnect → reconnect re-establishes the tunnel cleanly.
- Cleanup test: closing the IDE tab releases cluster resources (socket connections close).
- Cross-issue: confirms the route from #441's ReadyStep to the IDE page works (verify route path: `/orgs/:orgId/projects/:projectId/ide` per #447-Q1).

## Background

Original: #447. Per #447-Q2 clarification, dedicated tunnel message types alongside `api_request` was the chosen approach. The cloud-side `TunnelManager` was implemented; the cluster-side counterparts were not.

## User Stories

### US1: Open IDE from Bootstrap UI

**As a** developer setting up a Generacy cluster,
**I want** to click "Open IDE" on the bootstrap Ready screen and have a working code-server open in a new tab,
**So that** I can start editing code immediately without manual configuration.

**Acceptance Criteria**:
- [ ] Clicking "Open IDE" opens code-server in a new browser tab
- [ ] Connection establishes within 15 seconds (including auto-start)
- [ ] Code-server is auto-started if not already running

### US2: Long-Running IDE Sessions

**As a** developer using the IDE,
**I want** the tunnel to remain stable during extended editing sessions,
**So that** I don't lose my work or get disconnected unexpectedly.

**Acceptance Criteria**:
- [ ] Tunnel survives 30+ minutes of active editing
- [ ] Active tunnel traffic resets code-server idle timer
- [ ] Relay disconnect/reconnect re-establishes tunnel transparently

### US3: Clean IDE Tab Close

**As a** developer closing the IDE tab,
**I want** cluster resources (socket connections) to be released,
**So that** the cluster doesn't accumulate leaked resources.

**Acceptance Criteria**:
- [ ] Closing the IDE tab triggers `tunnel_close` from the cloud
- [ ] Socket connections are cleaned up on the cluster side

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `tunnel_open`, `tunnel_open_ack`, `tunnel_data`, `tunnel_close` Zod schemas to `RelayMessageSchema` | P1 | |
| FR-002 | Register tunnel message dispatch in cluster-relay client | P1 | |
| FR-003 | Implement `TunnelHandler` in control-plane with `RelayMessageSender` DI | P1 | Orchestrator injects relay.send |
| FR-004 | Restrict `target` to `/run/code-server.sock` only | P1 | Security: reject arbitrary paths |
| FR-005 | Auto-start code-server on `tunnel_open` with 10s timeout | P1 | Via `CodeServerManager.start()` |
| FR-006 | Reset code-server idle timer on inbound `tunnel_data` | P1 | Via `CodeServerManager.touch()` |
| FR-007 | Handle abrupt socket disconnects (send `tunnel_close`) | P1 | |
| FR-008 | Cluster-side stateless across relay reconnects | P2 | Cloud re-sends `tunnel_open` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | IDE opens successfully | 100% | Click "Open IDE", code-server loads |
| SC-002 | Session durability | 30+ min | Active editing session without disconnect |
| SC-003 | Reconnect recovery | Tunnel re-established | Disconnect relay, verify IDE resumes |
| SC-004 | Resource cleanup | 0 leaked sockets | Close tab, verify socket connections close |

## Assumptions

- Cloud-side `TunnelManager` is already implemented and sends correct tunnel message types
- Code-server is installed in the cluster container and listens on `/run/code-server.sock`
- The relay WebSocket connection is the sole transport for tunnel messages (no direct connections)
- `CodeServerManager` exposes `start()` and `touch()` methods

## Out of Scope

- Cloud-side `TunnelManager` changes (already implemented)
- Configurable socket path allowlist (v1.5 ships with single hardcoded path)
- Multiple simultaneous tunnel targets (only code-server for v1.5)
- Tunnel encryption beyond the relay's existing WebSocket TLS

---

*Generated by speckit*
