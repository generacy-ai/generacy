# Feature Specification: localhost-proxy Exposure Listener

**Branch**: `498-context-localhost-proxy` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Implement the real localhost-proxy exposure listener for the credhelper daemon, replacing the existing stub. The proxy hosts an HTTP listener on a configured localhost port, enforces a role-defined method+path allowlist, injects upstream auth headers, and forwards requests to the SaaS API.

## Context

`localhost-proxy` is the credentials-architecture answer for SaaS APIs without native scoping (SendGrid, Mailgun, etc.). The credhelper hosts an HTTP listener on a configured localhost port, enforces a role-defined method+path allowlist, injects the upstream auth header, and forwards. Currently this exposure is stubbed in the renderer; phase 9 ships the real implementation. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — "Exposure protocols (v1.5)".

## Scope

Implement in `packages/credhelper-daemon/src/exposure/localhost-proxy.ts` (new file):

- HTTP listener bound to `127.0.0.1:<port>` (port from role config).
- Per-listener config built from the role's `proxy:` block (keyed by `credRef.ref`): `upstream`, `default: deny`, `allow: [{method, path}]`.
- Match rules: method exact-match; path supports literal and `{param}` placeholder per credentials doc examples.
- Path matching: query strings stripped before matching; trailing slashes are significant (strict); case-sensitive.
- On match: inject upstream auth header (e.g. `Authorization: Bearer <secret>` for API-key plugins; specific shape determined by the resolving plugin's `renderExposure` for `localhost-proxy` mode).
- On no-match: respond 403 with a clear JSON error (`{ error, code, details? }` shape).
- On match but upstream error: pass-through.
- Per-session lifecycle: started by `ExposureRenderer` at session begin, stopped at session end. Track listener handles in session state (array/map pattern, similar to `dockerProxy`).
- Port allocation: v1.5 uses static ports from role config; collisions fail closed at session start with a clear error.
- Validation: session creation fails with a validation error if a credential uses `as: localhost-proxy` but the role has no matching `proxy:<credRef.ref>` entry.
- Agent discovery: write session env var for proxy URL. Env var name from `envName` field on the expose rule; falls back to `<CREDENTIAL_REF_UPPER>_PROXY_URL` if omitted. Add `envName?: string` to the localhost-proxy exposure schema.

Wire into `ExposureRenderer.render()` so a role exposure of `as: localhost-proxy` produces a real listener.

## Acceptance criteria

- SendGrid example role from credentials doc works end-to-end against a mocked upstream: `POST /v3/mail/send` succeeds with auth header injected; `GET /v3/mail/send` returns 403; arbitrary path returns 403.
- Listener teardown happens on session end.
- Static port collisions surface a clear error.
- Missing `proxy:` entry for localhost-proxy credential fails session creation with validation error naming the missing key.
- Session env var written with proxy URL (using `envName` or derived fallback).
- Integration test covers happy path, default-deny, and per-session teardown.
- Plaintext secret never logged.

## User Stories

### US1: Agent uses SaaS API through localhost proxy

**As a** cluster operator,
**I want** agent processes to access SaaS APIs (e.g., SendGrid) through a localhost proxy with method+path allowlisting,
**So that** credentials are never exposed to the agent and API access is scoped to only the allowed operations.

**Acceptance Criteria**:
- [ ] Proxy starts on configured port and forwards allowed requests with auth headers injected
- [ ] Disallowed methods/paths receive 403 JSON error
- [ ] Proxy URL is discoverable via session env var

### US2: Proxy lifecycle management

**As a** credhelper daemon,
**I want** proxy listeners to start at session begin and stop at session end,
**So that** ports are released and no stale listeners remain.

**Acceptance Criteria**:
- [ ] Listener starts when session begins with localhost-proxy exposure
- [ ] Listener stops when session ends
- [ ] Port collision at session start fails with clear error

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | HTTP listener on `127.0.0.1:<port>` from role config | P1 | |
| FR-002 | Method exact-match + path literal/`{param}` allowlist | P1 | Query strings stripped; trailing slashes significant; case-sensitive |
| FR-003 | Auth header injection from plugin `renderExposure` output | P1 | Plugin provides `headers: Record<string, string>` |
| FR-004 | 403 JSON error on disallowed requests | P1 | `{ error, code, details? }` shape |
| FR-005 | Upstream error pass-through | P1 | Forward upstream response as-is |
| FR-006 | Fail-closed validation when `proxy:` entry missing | P1 | Error names the missing key |
| FR-007 | Session env var for proxy URL | P1 | `envName` field or `<REF_UPPER>_PROXY_URL` fallback |
| FR-008 | Port collision detection at session start | P1 | Fail closed with clear error |
| FR-009 | Listener teardown on session end | P1 | Via handle pattern like DockerProxy |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Allowed request forwarded correctly | 100% | Integration test with mocked upstream |
| SC-002 | Disallowed request blocked | 100% | Integration test verifying 403 |
| SC-003 | Teardown completes | No leaked listeners | Port available after session end |

## Assumptions

- Static port allocation is sufficient for v1.5 (dynamic port allocation deferred)
- Role authors will list both `/path` and `/path/` if the upstream API treats them as separate endpoints
- Plugin's `renderExposure` output provides correct upstream URL and auth headers
- Proxy key in role's `proxy:` record matches `credRef.ref` name

## Out of Scope

- Dynamic port allocation
- HTTPS/TLS termination on the proxy listener
- WebSocket proxying
- Request body transformation or inspection
- Rate limiting

---

*Generated by speckit*
