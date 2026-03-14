# Feature Specification: Orchestrator Relay Integration

**Branch**: `380-phase-2-2-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

Wire the cluster-relay client into the orchestrator's startup sequence so that a running cluster automatically connects to generacy-cloud. The relay package (issue 2.1) provides the WebSocket client. This issue integrates it into the orchestrator so the connection is automatic and relay messages are routed to the correct handlers.

## Context

The cloud platform buildout (Phase 2) enables on-premise Generacy clusters to connect to the generacy-cloud SaaS platform. Phase 2.1 delivered the `@generacy-ai/cluster-relay` WebSocket client package. This issue (Phase 2.2) integrates that relay into the orchestrator so the connection happens automatically on startup and all API/event traffic is bridged transparently.

## User Stories

### US1: Automatic cloud connection

**As a** cluster operator,
**I want** my orchestrator to automatically connect to generacy-cloud when an API key is configured,
**So that** I can manage and monitor my cluster remotely without manual setup.

**Acceptance Criteria**:
- [ ] Orchestrator connects to cloud relay on startup when `GENERACY_API_KEY` is set
- [ ] Orchestrator starts normally in local-only mode when no API key is configured
- [ ] Connection status is logged (connected, disconnected, reconnecting)

### US2: Remote API access via relay

**As a** cloud platform user,
**I want** to invoke orchestrator API endpoints through the cloud relay,
**So that** I can control workflows on my cluster without direct network access.

**Acceptance Criteria**:
- [ ] All existing Fastify endpoints are callable via relay `api_request` messages
- [ ] Responses are returned via relay `api_response` messages
- [ ] No endpoint duplication — uses Fastify `inject()` internally

### US3: Real-time event streaming via cloud

**As a** cloud dashboard user,
**I want** to receive workflow lifecycle and progress events through the cloud,
**So that** I get the same real-time visibility as a direct SSE connection.

**Acceptance Criteria**:
- [ ] SSE events (workflow lifecycle, phase progress, errors) are forwarded as relay `event` messages
- [ ] Cloud subscribers receive events equivalent to direct SSE

### US4: Cluster visibility in cloud dashboard

**As a** cloud platform administrator,
**I want** my cluster's metadata (worker count, active workflows, version) reported to the cloud,
**So that** the cloud dashboard shows current cluster status.

**Acceptance Criteria**:
- [ ] Metadata reported on connect/reconnect
- [ ] Metadata refreshed periodically (every 60s)
- [ ] Includes: worker count, active workflow count, channel, version, git remotes, uptime

### US5: Graceful offline transition

**As a** cluster operator,
**I want** the relay to disconnect cleanly on shutdown,
**So that** the cloud dashboard accurately reflects my cluster as offline.

**Acceptance Criteria**:
- [ ] SIGTERM/SIGINT triggers relay disconnect before process exit
- [ ] Cloud receives disconnect and marks cluster offline

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Instantiate and connect relay on startup when `GENERACY_API_KEY` is set | P1 | Read cluster metadata from `.generacy/cluster.yaml` and environment |
| FR-002 | Orchestrator works fully without relay (local-only mode) | P1 | Relay is opt-in via API key presence |
| FR-003 | Log relay connection status changes | P1 | Connected, disconnected, reconnecting |
| FR-004 | Route incoming `api_request` relay messages to Fastify via `inject()` | P1 | No HTTP overhead, no endpoint duplication |
| FR-005 | Return Fastify responses as `api_response` relay messages | P1 | |
| FR-006 | Forward SSE events through relay as `event` messages | P1 | Subscribe to orchestrator event bus |
| FR-007 | Report cluster metadata on connect/reconnect | P2 | Worker count, active workflows, channel, version, git remotes, uptime |
| FR-008 | Periodically refresh metadata (60s interval) | P2 | Keeps cloud dashboard current |
| FR-009 | Disconnect relay on SIGTERM/SIGINT before shutdown | P1 | Cloud receives disconnect event |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Orchestrator starts with relay when API key is set | 100% | Integration test with mock relay server |
| SC-002 | Orchestrator starts without relay when no API key | 100% | Integration test without env var |
| SC-003 | API requests round-trip through relay | All existing endpoints | Test `api_request` → `inject()` → `api_response` flow |
| SC-004 | SSE events forwarded via relay | All event types | Verify event bus subscription and relay forwarding |
| SC-005 | Metadata reported on connect | All required fields present | Validate metadata payload schema |
| SC-006 | Graceful shutdown disconnects relay | Clean disconnect observed | Test SIGTERM handling |

## Technical Notes

- Orchestrator entry point: `packages/orchestrator/src/index.ts`
- Fastify `inject()` for internal request routing (no HTTP overhead)
- Existing SSE implementation: `packages/orchestrator/src/routes/events.ts`
- Cluster metadata from `.generacy/cluster.yaml` (issue 1.8)
- Reference: `docs/cloud-platform-buildout-reference.md` in tetrad-development

## Dependencies

- Issue 2.1 (`@generacy-ai/cluster-relay` package) — provides the WebSocket relay client
- Issue 1.8 (cluster.yaml) — provides cluster metadata schema and reading

## Assumptions

- The `@generacy-ai/cluster-relay` package is published and available (Phase 2.1 complete)
- `.generacy/cluster.yaml` exists and is readable when relay is configured (Phase 1.8 complete)
- The orchestrator event bus emits all SSE event types that need forwarding
- `GENERACY_API_KEY` is the sole trigger for enabling relay — no additional config needed

## Out of Scope

- Relay client package implementation (covered by issue 2.1)
- Cloud-side relay server implementation
- Authentication/authorization of relay messages (handled by relay package)
- Cloud dashboard UI
- Multi-cluster management from a single orchestrator

---

*Generated by speckit*
