# Feature Specification: Package the worker→control-plane git-token proxy into `@generacy-ai/control-plane`

**Branch**: `768-summary-worker-side-git` | **Date**: 2026-06-05 | **Status**: Draft | **Issue**: [#768](https://github.com/generacy-ai/generacy/issues/768)

## Summary

The worker-side **git-token proxy** — which lets worker containers reach the orchestrator's control-plane to mint a git token — currently lives as a standalone, untested script in cluster-base (`.devcontainer/generacy/scripts/git-token-proxy.js`, ~138 lines). Move it into `@generacy-ai/control-plane` as a bin, co-located with the existing `git-credential-generacy` helper, so it is typed, unit-tested, and versioned with the control-plane protocol it forwards.

The packaged bin must ship at `@generacy-ai/control-plane/dist/bin/git-token-proxy.js` so cluster-base's `entrypoint-orchestrator.sh` can launch it from `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js`. This mirrors the path already used for `git-credential-generacy` (see `packages/control-plane/package.json` `bin` map).

## Why

This proxy is **security-relevant** application logic, not glue:

- It exposes **exactly one capability** to workers — `POST /git-token` — and 404s every other path and method. Workers (and the uid-1001 agent-workflow processes that share the `node` group via Unix socket permissions) must not be able to reach the orchestrator's full control socket (credential writes, lifecycle actions). That allow-list is a security boundary that deserves direct unit tests.
- It maps upstream-socket failures to a typed `CONTROL_SOCKET_UNREACHABLE` (`502`) so the helper never silently falls back to a stale on-disk token (see `packages/control-plane/bin/git-credential-generacy.ts:107` for the consuming exit-code mapping).
- The git credential helper is already a generacy package (`git-credential-generacy`); the proxy is the architectural odd-one-out. A loose `.js` in cluster-base cannot be type-checked, unit-tested, or versioned alongside the `/git-token` control-plane route (`packages/control-plane/src/routes/git-token.ts`) it depends on — drift risk if that route's request/response shape changes.

## User Stories

### US1: Cluster operator gets a versioned, tested git-token proxy (P1)

**As a** cluster operator (or anyone reviewing the cluster's security boundary),
**I want** the worker→control-plane git-token proxy to live in `@generacy-ai/control-plane` with TypeScript types and unit tests,
**So that** changes to the control-plane `/git-token` route, request/response shape, or allow-list can't silently drift out of sync with what workers depend on, and the security boundary (single-route allow-list, typed error mapping) is verifiable in CI.

**Acceptance Criteria**:
- [ ] `@generacy-ai/control-plane` declares a `git-token-proxy` bin entry that compiles to `dist/bin/git-token-proxy.js`.
- [ ] Bin is built by the package's existing `pnpm build` (no new build tooling).
- [ ] Bin is launchable via `node /shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js` with no extra args.
- [ ] Unit tests cover the single-route allow-list (anything other than `POST /git-token` returns 404), the happy-path forwarding to the upstream control socket, and the `CONTROL_SOCKET_UNREACHABLE` mapping on upstream-socket failure.

### US2: Worker process can mint a git token via the proxy with identical behavior (P1)

**As a** worker process (running as uid 1001, member of the `node` group) using the `git-credential-generacy` helper,
**I want** the packaged proxy to behave bit-identically to the current `cluster-base/.devcontainer/generacy/scripts/git-token-proxy.js` script,
**So that** the cluster-base companion PR can swap the script for the packaged bin without touching the worker-side helper or git config wiring.

**Acceptance Criteria**:
- [ ] Listen socket path defaults to `/run/generacy-git-token/control.sock`, overridable via `GIT_TOKEN_PROXY_SOCKET`.
- [ ] Upstream socket path defaults to `/run/generacy-control-plane/control.sock`, overridable via `CONTROL_PLANE_SOCKET_PATH`.
- [ ] Listen socket is created with file mode `0660` (group-readable; relies on the `node` group to grant uid-1001 access).
- [ ] On boot, any stale socket file at the listen path is removed before bind.
- [ ] `POST /git-token` forwards the request body (and `content-type`/`content-length` headers) to the upstream socket and pipes the upstream response back verbatim (status code, body).
- [ ] Any other method or path returns HTTP `404` with body `{ "error": "not found", "code": "NOT_FOUND" }` (matching the existing script's contract).
- [ ] Upstream connect/transport failure returns HTTP `502` with body `{ "error": "<detail>", "code": "CONTROL_SOCKET_UNREACHABLE" }`.
- [ ] `SIGTERM` and `SIGINT` close the listening socket, unlink the socket file, and exit `0`.

### US3: Companion cluster-base PR can drop the bundled script (P2)

**As a** cluster-base maintainer preparing the companion PR,
**I want** the packaged bin to be reachable from the existing `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/…` mount,
**So that** I can update `entrypoint-orchestrator.sh` to launch it and delete `.devcontainer/generacy/scripts/git-token-proxy.js` in the same PR.

**Acceptance Criteria**:
- [ ] Bin path is exactly `@generacy-ai/control-plane/dist/bin/git-token-proxy.js` (mirrors `git-credential-generacy.js`).
- [ ] `package.json` `bin` map exposes `git-token-proxy` so pnpm/npm linking is consistent across both bins.
- [ ] No new runtime dependencies introduced (the proxy uses only `node:http`, `node:fs`, `node:net`, `node:path` — same constraints as the existing script).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Bin entry compiled to `dist/bin/git-token-proxy.js`. | P1 | Mirrors `git-credential-generacy.ts`. |
| FR-002 | Listen on Unix socket at `GIT_TOKEN_PROXY_SOCKET` (default `/run/generacy-git-token/control.sock`). | P1 | |
| FR-003 | Forward upstream to `CONTROL_PLANE_SOCKET_PATH` (default `/run/generacy-control-plane/control.sock`). | P1 | |
| FR-004 | Allow-list: only `POST /git-token` is forwarded; everything else returns `404 { error, code: 'NOT_FOUND' }`. | P1 | Security boundary; unit-tested. |
| FR-005 | Forwarded request preserves body bytes and forwards back the upstream status + body. | P1 | Body is small JSON (`{}`), but stream-pipe it rather than reading into memory if simple. |
| FR-006 | Upstream socket connect/transport failure returns `502 { error, code: 'CONTROL_SOCKET_UNREACHABLE' }`. | P1 | Must NOT fall back to any cached / on-disk token. |
| FR-007 | Stale listen-socket file (if present) is unlinked before bind on boot. | P1 | Idempotent restart. |
| FR-008 | Listen-socket mode is `0660` after bind. | P1 | Uid-1001 workers reach it via the `node` group. |
| FR-009 | `SIGTERM` and `SIGINT` close the server, unlink the socket file, and exit `0`. | P1 | Graceful shutdown. |
| FR-010 | Unit tests cover: allow-list (multiple denied methods/paths), happy-path forwarding (fake upstream returns 200 → proxy returns 200), upstream-failure mapping. | P1 | Required acceptance. |
| FR-011 | No new runtime dependencies; implementation uses Node built-ins only. | P2 | Matches the existing script and `git-credential-generacy.ts`. |
| FR-012 | TypeScript source, strict mode, matches package `tsconfig.json`. | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Packaged bin behavior matches the cluster-base script. | 100% behavioral parity for the cases listed in FR-002…FR-009. | Diff the runtime contract; unit tests pass. |
| SC-002 | Allow-list is enforced. | Unit test asserts every non-`POST /git-token` request returns 404 (covers at least: `GET /git-token`, `POST /credentials/x`, `POST /lifecycle/x`, `GET /state`). | `vitest` in `packages/control-plane`. |
| SC-003 | Upstream failure produces typed error, never falls through. | Unit test stubs an unreachable upstream socket and asserts `502 { code: 'CONTROL_SOCKET_UNREACHABLE' }`. | `vitest`. |
| SC-004 | Companion cluster-base PR can drop the bundled script with a one-line entrypoint change. | After merge, the cluster-base script can be deleted with no other cluster-base code edits beyond the launch path. | Confirmed when the companion PR opens. |

## Assumptions

- The control-plane process already exposes `POST /git-token` at `/run/generacy-control-plane/control.sock` (#766). This proxy only forwards; it does not implement the cloud-pull or caching logic.
- The `node` group exists in the worker and orchestrator containers, with uid-1001 (workers) and uid-1000 (orchestrator) both members; cluster-base owns that wiring.
- pnpm/npm linking of bins follows the existing `git-credential-generacy` pattern — no new linker config required.
- The packaged bin is launched as a long-lived child process by `entrypoint-orchestrator.sh` (not as a CLI per invocation); SIGTERM/SIGINT lifecycle is the entry path that matters.

## Out of Scope

- Caching, token minting, or fallback behavior of any kind — those live in the upstream control-plane (`/git-token` route) and the cloud-pull client (`packages/control-plane/src/services/cloud-pull-client.ts`).
- Changes to the worker-side `git-credential-generacy` helper (already correct; uses `CONTROL_PLANE_SOCKET_PATH` which workers point at the proxy's listen socket).
- The companion cluster-base PR (`entrypoint-orchestrator.sh` rewiring, deletion of `.devcontainer/generacy/scripts/git-token-proxy.js`) — tracked separately; this issue lands first so that PR has a bin to point at.
- Multi-credential routing, request inspection, or any new control-plane endpoints exposed to workers.
- TLS, auth tokens, or any per-request authentication on the proxy listen socket — access is granted via Unix-socket file mode + group membership only (unchanged from the current script).

## Dependencies

- **Upstream**: control-plane `/git-token` route shape (`packages/control-plane/src/routes/git-token.ts`) and `git-credential-generacy.ts` exit-code contract. Both already match what the existing script assumes.
- **Downstream (companion PR)**: cluster-base `entrypoint-orchestrator.sh` switch from the bundled script to `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js`. Must land *after* this issue so the bin path exists.
- **Context**: introduced in generacy-ai/cluster-base#61; helper from generacy-ai/generacy#766.

---

*Generated by speckit*
