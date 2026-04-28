# Feature Specification: Cluster-relay protocol additions and path-prefix dispatcher

**Branch**: `489-context-v1-5-introduces` | **Date**: 2026-04-28 | **Status**: Draft

## Summary

Extend the cluster-relay protocol with optional `actor` and `activation` fields on existing messages, and replace the single-target forwarding model with a path-prefix dispatcher. This enables the v1.5 cloud-hosted bootstrap UI to drive an in-cluster control-plane service via the relay without breaking existing consumers.

## Context

v1.5 introduces a cloud-hosted bootstrap UI on generacy.ai that drives an in-cluster control-plane HTTP service via the existing cluster-relay. The relay protocol needs additive extensions and a path-prefix dispatcher to support this. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "Cluster-relay extension".

## Scope

Extend the relay protocol with optional fields and add a path-prefix dispatcher to the cluster-side relay client.

In `packages/cluster-relay/src/messages.ts`:
- Add optional `actor?: { userId: string; sessionId?: string }` to `ApiRequestMessage` so cloud-side relay forwards can attach the calling user's identity.
- Add optional `activation?: { code: string; clusterApiKeyId?: string }` to `HandshakeMessage` for first-launch claim and reconnect-with-API-key flows.
- Both fields are optional. Old senders/receivers remain valid — no breaking change.

In `packages/cluster-relay/src/proxy.ts`:
- Replace the single-target forwarding model with a path-prefix dispatcher. New config shape accepts a list of `{ prefix, target }` pairs where target is either an HTTP URL or a Unix socket path.
- Default behavior preserved: `/control-plane/*` routes to a configurable Unix socket (default `/run/generacy-control-plane/control.sock`); all other paths preserve existing orchestrator-HTTP forwarding.
- Wire the new `actor` field through to the forwarded HTTP request as headers (e.g. `x-generacy-actor-user-id`, `x-generacy-actor-session-id`) so the downstream service can read it without parsing the relay message.

## Acceptance criteria

- Old shape of `ApiRequestMessage`/`HandshakeMessage` still parses (additive fields are optional).
- Dispatcher unit tests cover: control-plane prefix -> Unix socket; non-matching prefix -> orchestrator HTTP; no-match -> 404.
- `actor` is propagated to forwarded HTTP requests as headers when present, omitted when absent.
- All existing relay tests pass.
- Documentation: update package README with the new dispatcher config shape.

## User Stories

### US1: Cloud bootstrap UI routes requests to in-cluster control plane

**As a** platform operator using the generacy.ai bootstrap UI,
**I want** the relay to route `/control-plane/*` requests to the in-cluster control-plane service,
**So that** I can manage cluster setup and configuration from the cloud UI without direct network access to the cluster.

**Acceptance Criteria**:
- [ ] Requests with path prefix `/control-plane/` are forwarded to the control-plane Unix socket
- [ ] Non-matching paths continue to route to the orchestrator HTTP target
- [ ] Paths that match no configured prefix return 404

### US2: Cloud relay attaches user identity to forwarded requests

**As a** downstream in-cluster service (e.g. control plane),
**I want** the relay to forward the calling user's identity as HTTP headers,
**So that** I can authorize and audit requests without parsing relay protocol messages.

**Acceptance Criteria**:
- [ ] `x-generacy-actor-user-id` header is set when `actor.userId` is present
- [ ] `x-generacy-actor-session-id` header is set when `actor.sessionId` is present
- [ ] Headers are omitted when `actor` is absent (no empty-string headers)

### US3: First-launch activation and API-key reconnect via handshake

**As a** cluster operator performing first-launch setup or reconnecting with an API key,
**I want** the handshake message to carry activation codes and API key identifiers,
**So that** the relay can authenticate the cluster during initial claim and subsequent reconnects.

**Acceptance Criteria**:
- [ ] `HandshakeMessage` accepts optional `activation.code` for first-launch claim
- [ ] `HandshakeMessage` accepts optional `activation.clusterApiKeyId` for reconnect
- [ ] Existing handshake messages without `activation` continue to parse successfully

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add optional `actor` field to `ApiRequestMessage` Zod schema | P1 | `{ userId: string; sessionId?: string }` |
| FR-002 | Add optional `activation` field to `HandshakeMessage` Zod schema | P1 | `{ code: string; clusterApiKeyId?: string }` |
| FR-003 | Implement path-prefix dispatcher in proxy replacing single-target model | P1 | Config: `Array<{ prefix: string; target: string }>` |
| FR-004 | Route `/control-plane/*` to configurable Unix socket | P1 | Default: `/run/generacy-control-plane/control.sock` |
| FR-005 | Preserve existing orchestrator-HTTP forwarding for non-matching paths | P1 | Backwards compatibility |
| FR-006 | Propagate `actor` fields as `x-generacy-actor-*` HTTP headers | P1 | Only when present |
| FR-007 | Return 404 for paths matching no configured prefix | P2 | |
| FR-008 | Update package README with new dispatcher config shape | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Backwards compatibility | 100% existing tests pass | Run existing relay test suite |
| SC-002 | Dispatcher coverage | Unit tests for all 3 routing cases | prefix match -> Unix socket, non-match -> orchestrator, no-match -> 404 |
| SC-003 | Actor header propagation | Present when set, absent when unset | Unit tests for header forwarding with and without actor |
| SC-004 | Schema additivity | Old messages parse without error | Validate existing message fixtures against updated schemas |

## Assumptions

- The cluster-relay package uses Zod for message schema validation
- Unix socket forwarding can reuse or extend existing HTTP forwarding logic
- The control-plane service will be available at the default socket path in production
- No authentication/authorization logic is needed in the relay itself — it only forwards identity headers

## Out of Scope

- Control-plane service implementation (separate feature)
- Cloud-side relay sender changes (only cluster-side receiver is modified here)
- Authentication or authorization logic within the relay
- TLS termination or encryption changes
- Load balancing across multiple targets for the same prefix

---

*Generated by speckit*
