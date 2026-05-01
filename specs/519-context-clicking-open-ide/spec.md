# Feature Specification: Cluster-side IDE tunnel proxy

Clicking "Open IDE" hangs forever in "Connecting..." with no error — tunnel messages are silently dropped.

**Branch**: `519-context-clicking-open-ide` | **Date**: 2026-05-01 | **Status**: Draft

## Summary

The cloud-side `TunnelManager` sends `tunnel_open`/`tunnel_data`/`tunnel_close` messages to the cluster, but two pieces are missing:
1. The cluster-relay `RelayMessageSchema` discriminated union doesn't include tunnel message types — they're silently dropped at Zod parse time.
2. No cluster-side handler exists to open a Unix socket to code-server, acknowledge the tunnel, or proxy data bidirectionally.

This fix adds four tunnel message types to the relay schema, registers dispatch for them, and implements a tunnel handler in the control-plane that proxies data between the relay WebSocket and the local code-server Unix socket.

## Files

- `packages/cluster-relay/src/messages.ts:177-185` — `RelayMessageSchema` discriminated union excludes tunnel types.
- `packages/cluster-relay/src/relay.ts:311-327` — only `api_request` is hardcoded-handled; nothing dispatches tunnel messages.
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
   - Registers via `relay.onMessage()` for tunnel message types.
   - On `tunnel_open`: open Unix socket connection at `target`; on success send `tunnel_open_ack { status: 'ok' }`; on error send `{ status: 'error', error }`.
   - On `tunnel_data`: forward bytes bidirectionally between socket and relay.
   - On `tunnel_close`: close the socket and clean up.
   - Handle abrupt disconnects (socket closed without explicit `tunnel_close`).
4. **Wire handler at control-plane startup** so it's active when the cluster boots.

## User Stories

### US1: Developer opens IDE from bootstrap UI

**As a** developer using the Generacy bootstrap UI,
**I want** to click "Open IDE" and have a working code-server instance appear in a new browser tab,
**So that** I can begin editing code in my cluster without manual SSH or port-forwarding.

**Acceptance Criteria**:
- [ ] Clicking "Open IDE" on the Ready screen opens code-server in a new tab within 5 seconds
- [ ] The IDE session remains functional for 30+ minutes of continuous editing
- [ ] Closing the IDE tab releases cluster-side socket connections

### US2: Resilient IDE session across relay reconnects

**As a** developer with an active IDE session,
**I want** the tunnel to re-establish automatically if the relay WebSocket disconnects and reconnects,
**So that** transient network issues don't force me to restart my editing session.

**Acceptance Criteria**:
- [ ] After relay disconnect/reconnect, IDE session resumes without manual intervention
- [ ] In-flight data is not corrupted across reconnect boundaries

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `tunnel_open`, `tunnel_open_ack`, `tunnel_data`, `tunnel_close` Zod schemas to `RelayMessageSchema` | P0 | Without this, tunnel messages are silently dropped |
| FR-002 | Extend relay message dispatch to route tunnel message types to registered handlers | P0 | Follows existing `messageHandlers` pattern |
| FR-003 | Implement `TunnelHandler` that opens Unix socket to `target` path on `tunnel_open` | P0 | Default target: `/run/code-server.sock` |
| FR-004 | Proxy `tunnel_data` bidirectionally (relay WS <-> Unix socket) with base64 encoding | P0 | |
| FR-005 | Send `tunnel_open_ack` with status on connection success/failure | P0 | Fail-closed: error response if socket unreachable |
| FR-006 | Clean up socket connections on `tunnel_close` and abrupt disconnects | P0 | Prevent resource leaks |
| FR-007 | Wire `TunnelHandler` at control-plane startup | P0 | Must be active before first relay message |
| FR-008 | Handle relay reconnect: clean up stale tunnels, allow re-establishment | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | IDE opens successfully | 100% of attempts | Click "Open IDE", verify code-server loads |
| SC-002 | Session durability | 30+ minutes | Continuous editing without disconnection |
| SC-003 | Reconnect recovery | Tunnel re-established | Kill relay WS, verify IDE resumes |
| SC-004 | Resource cleanup | 0 leaked sockets | Close IDE tab, verify no orphan connections |
| SC-005 | Route integration | IDE page accessible | Navigate `/orgs/:orgId/projects/:projectId/ide` per #447-Q1 |

## Assumptions

- Cloud-side `TunnelManager` is already implemented and sends correct message formats (per #447)
- `code-server` is running in the cluster and listening on `/run/code-server.sock`
- The relay WebSocket connection is already established before tunnel messages are sent
- Dedicated tunnel message types alongside `api_request` was the chosen approach (per #447-Q2)

## Out of Scope

- Cloud-side `TunnelManager` changes (already implemented)
- code-server installation or configuration
- Multi-tunnel multiplexing beyond what `tunnelId` already supports
- End-to-end encryption of tunnel data (handled at WebSocket layer)

## Background

Original: #447. Per #447-Q2 clarification, dedicated tunnel message types alongside `api_request` was the chosen approach. The cloud-side `TunnelManager` was implemented; the cluster-side counterparts were not.

---

*Generated by speckit*
