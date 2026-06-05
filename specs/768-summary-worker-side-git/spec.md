# Feature Specification: ## Summary

The worker-side **git-token proxy** — which lets worker containers reach the orchestrator's control-plane to mint a git token — currently lives as a standalone, untested script in cluster-base (`

**Branch**: `768-summary-worker-side-git` | **Date**: 2026-06-05 | **Status**: Draft

## Summary

## Summary

The worker-side **git-token proxy** — which lets worker containers reach the orchestrator's control-plane to mint a git token — currently lives as a standalone, untested script in cluster-base (`.devcontainer/generacy/scripts/git-token-proxy.js`, ~138 lines). Move it into **`@generacy-ai/control-plane`** as a bin, co-located with the existing `git-credential-generacy` helper, so it's typed, unit-tested, and versioned with the control-plane protocol it forwards.

## Why

It's small but **security-relevant** application logic, not glue:
- It deliberately exposes **exactly one capability** to workers — `POST /git-token` — and 404s everything else, so workers (and the uid-1001 agent-workflow processes sharing the `node` group) can't reach the orchestrator's full control socket (credential writes, lifecycle actions). That allow-list is a security boundary that deserves tests.
- It maps upstream-socket failures to a typed `CONTROL_SOCKET_UNREACHABLE` so the helper never silently falls back to a stale token.

The git credential helper is already a generacy package (`git-credential-generacy`); the proxy is the architectural odd-one-out. A loose `.js` in cluster-base can't be type-checked, unit-tested, or versioned alongside the `/git-token` control-plane route it depends on (drift risk if that route's shape changes).

## Scope (this repo)

- Port `git-token-proxy.js` into `@generacy-ai/control-plane` as a bin — ship at **`@generacy-ai/control-plane/dist/bin/git-token-proxy.js`** (mirrors the `git-credential-generacy` bin path that cluster-base already references), so the cluster-base entrypoint can launch it from `/shared-packages`.
- Preserve behavior exactly: env `GIT_TOKEN_PROXY_SOCKET` (default `/run/generacy-git-token/control.sock`) + `CONTROL_PLANE_SOCKET_PATH`; single `POST /git-token` route, 404 on anything else; `502 CONTROL_SOCKET_UNREACHABLE` on upstream failure; listen-socket perms `0660`; stale-socket cleanup on boot; `SIGTERM`/`SIGINT` graceful shutdown.
- Add unit tests for the allow-list (only `POST /git-token` forwarded), the forwarding, and the unreachable-upstream error mapping.

## Acceptance criteria

- [ ] `@generacy-ai/control-plane` ships a `git-token-proxy` bin at the path above with identical runtime behavior.
- [ ] Unit tests cover the single-route allow-list and the `CONTROL_SOCKET_UNREACHABLE` path.
- [ ] cluster-base launches the packaged bin and drops the bundled script (companion PR — see below).

## Dependencies

- **cluster-base wiring:** a companion cluster-base PR (already being prepared) updates `entrypoint-orchestrator.sh` to launch this packaged bin from `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js` and removes `.devcontainer/generacy/scripts/git-token-proxy.js`. Land this issue first so that PR has the bin to point at.
- Context: introduced in generacy-ai/cluster-base#61; serves the helper from generacy-ai/generacy#766.

## Resolved Clarifications

Decisions from [clarifications.md](./clarifications.md) Batch 1 (2026-06-05) that bind implementation:

- **Listen-socket parent directory** (Q1 → A): The bin **does not** create or probe `dirname(GIT_TOKEN_PROXY_SOCKET)`. cluster-base owns the `/run/generacy-git-token/` tmpfs lifecycle. On bind failure, exit non-zero with a structured stderr line that names the missing path.
- **Request header passthrough** (Q2 → A): Forward **only** `content-type` and `content-length` to upstream. Strip every other request header (`host`, `authorization`, `accept`, all `x-*`, etc.). The allow-list is part of the privilege boundary and must be tested explicitly.
- **Logging** (Q3 → A): Structured JSON lines on stdout. Emit exactly two event types: `{ event: 'git-token-proxy-init', listenSocket, upstreamSocket }` on startup, and `{ event: 'git-token-proxy-upstream-error', code }` on upstream failure. **Never log request bodies, request headers, response bodies, or tokens.**
- **Test style** (Q4 → C): Hybrid. Pure-function tests for the route allow-list, header allow-list, and `CONTROL_SOCKET_UNREACHABLE` error mapping (cross-platform, fast). Plus one real Unix-socket smoke test covering bind, `0660` socket mode, single-route enforcement on the wire, and SIGTERM cleanup — skipped automatically on non-POSIX.
- **Body-size and upstream timeout** (Q5 → B): Enforce max request body **64 KiB** → respond `413 Payload Too Large` on overflow. Enforce **30 s** upstream-response timeout → mapped to `502 CONTROL_SOCKET_UNREACHABLE` (same as other transport failures). Both bounds documented in the bin source.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
