# Feature Specification: Localhost-Proxy Exposure Listener

**Branch**: `498-context-localhost-proxy` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Implement the `localhost-proxy` exposure protocol for the credhelper daemon. This enables secure access to SaaS APIs that lack native credential scoping (e.g. SendGrid, Mailgun) by hosting a local HTTP reverse proxy that enforces a role-defined method+path allowlist and injects upstream auth headers transparently.

## Context

`localhost-proxy` is the credentials-architecture answer for SaaS APIs without native scoping. The credhelper hosts an HTTP listener on a configured localhost port, enforces a role-defined method+path allowlist, injects the upstream auth header, and forwards. Currently this exposure is stubbed in the renderer; phase 9 ships the real implementation. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — "Exposure protocols (v1.5)".

## Scope

Implement in `packages/credhelper-daemon/src/exposure/localhost-proxy.ts` (new file):

- HTTP listener bound to `127.0.0.1:<port>` (port from role config).
- Per-listener config built from the role's `proxy:` block: `upstream`, `default: deny`, `allow: [{method, path}]`.
- Match rules: method exact-match; path supports literal and `{param}` placeholder per credentials doc examples.
- On match: inject upstream auth header (e.g. `Authorization: Bearer <secret>` for API-key plugins; specific shape determined by the resolving plugin's `renderExposure` for `localhost-proxy` mode).
- On no-match: respond 403 with a clear JSON error.
- On match but upstream error: pass-through.
- Per-session lifecycle: started by `ExposureRenderer` at session begin, stopped at session end. Track listeners in the session state.
- Port allocation: v1.5 uses static ports from role config; collisions fail closed at session start with a clear error (per Open question #6).

Wire into `ExposureRenderer.render()` so a role exposure of `as: localhost-proxy` produces a real listener.

## User Stories

### US1: Agent safely calls unscoped SaaS API

**As an** AI agent running within a Generacy cluster,
**I want** my SaaS API requests to be proxied through a local listener that enforces allowed operations and injects credentials,
**So that** I can interact with APIs like SendGrid without direct access to the raw API key and without exceeding the allowed operation set.

**Acceptance Criteria**:
- [ ] Allowed requests (e.g. `POST /v3/mail/send`) are forwarded with the upstream auth header injected
- [ ] Disallowed requests (wrong method or path) receive a 403 JSON error
- [ ] The plaintext secret is never exposed to the agent process

### US2: Session-scoped proxy lifecycle

**As the** credhelper daemon,
**I want** localhost-proxy listeners to start when a credential session begins and stop when it ends,
**So that** proxy ports are not leaked and each session is isolated.

**Acceptance Criteria**:
- [ ] Listener starts on session begin and binds to the configured port
- [ ] Listener is torn down on session end (graceful close)
- [ ] Port collision at session start produces a clear, actionable error

### US3: Operator configures proxy allowlist via role definition

**As a** cluster operator defining credential roles,
**I want** to specify an allowlist of method+path rules in the role's `proxy:` block,
**So that** I can restrict agent access to only the API endpoints required for the task.

**Acceptance Criteria**:
- [ ] Role config `proxy:` block accepts `upstream`, `default: deny`, and `allow: [{method, path}]`
- [ ] Path patterns support both literal paths and `{param}` placeholders
- [ ] Method matching is exact (e.g. `POST` does not match `GET`)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | HTTP listener binds to `127.0.0.1:<port>` using `node:http` | P1 | Port from role config, no wildcard bind |
| FR-002 | Default-deny: all requests rejected unless explicitly allowed | P1 | 403 JSON response: `{ error, code }` |
| FR-003 | Allowlist matching: exact method + literal or `{param}` path | P1 | `{param}` matches a single path segment |
| FR-004 | Auth header injection on allowed requests before forwarding | P1 | Header shape from plugin's `renderExposure` |
| FR-005 | Upstream errors passed through transparently | P1 | Proxy does not mask upstream 4xx/5xx |
| FR-006 | Listener tracked in session state, torn down on session end | P1 | Graceful `server.close()` |
| FR-007 | Static port collision fails closed with clear error at session start | P1 | `EADDRINUSE` detection |
| FR-008 | Wire into `ExposureRenderer.render()` for `as: localhost-proxy` | P1 | Replace existing stub |
| FR-009 | Plaintext secrets never logged | P1 | Audit all log statements |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | SendGrid example role works end-to-end | Pass | `POST /v3/mail/send` proxied with auth; `GET /v3/mail/send` returns 403 |
| SC-002 | Session teardown closes listener | Pass | Integration test verifies port freed after session end |
| SC-003 | Port collision error is actionable | Pass | Error message includes port number and suggests resolution |
| SC-004 | Test coverage | 100% of acceptance criteria | Integration tests for happy path, default-deny, teardown |
| SC-005 | No secret leakage in logs | Pass | Grep test output and source for plaintext secret patterns |

## Assumptions

- The credhelper daemon runs as a single process; no cross-process port coordination is needed beyond `EADDRINUSE` detection.
- `node:http` is sufficient for the proxy (no need for `node:https` on the local listener side — TLS terminates at upstream).
- Role config schema for `proxy:` block is already defined in the credentials architecture doc.
- `{param}` placeholder matches exactly one non-empty path segment (no wildcards, no regex).
- Static port allocation is acceptable for v1.5; dynamic port allocation is out of scope.

## Out of Scope

- Dynamic port allocation and port-range scanning.
- TLS on the local listener (upstream connection may use HTTPS, but the local proxy binds plain HTTP on loopback).
- Rate limiting or request throttling on the proxy.
- Request/response body inspection or mutation.
- Multi-process port coordination (e.g. via lock files or IPC).
- WebSocket proxying.

---

*Generated by speckit*
