# Implementation Plan: Cluster-side JIT git credential helper

**Feature**: A git credential helper hosted in `packages/control-plane`, fronted by a thin per-invocation CLI wrapper. Returns a fresh GitHub installation token per `git` operation from the cloud on-demand pull endpoint (generacy-cloud#817), with a short in-memory cache and synchronous pre-expiry refresh.
**Branch**: `766-summary-implement-git`
**Status**: Complete
**Date**: 2026-06-05
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/766-summary-implement-git/spec.md`

## Summary

Replace the static `wizard-credentials.env` `GH_TOKEN` as the source of truth for **git** auth with an on-demand credential helper.

1. **Control-plane endpoint** — new `POST /git-token` on the control socket. Calls the cloud on-demand pull endpoint (generacy-cloud#817) using the cluster API key at `/var/lib/generacy/cluster-api-key`. Returns `{ token, expiresAt }`.
2. **In-process cache + dedup** — singleton `GitTokenManager` inside control-plane holds the most recent token and its `expiresAt`. Refreshes synchronously when `expiresAt - now ≤ 5 min` (FR-004). Concurrent `get` calls collapse to a single in-flight cloud fetch (FR-009).
3. **Thin CLI wrapper** — a new bin `git-credential-generacy` (shipped from `packages/control-plane`) speaks the git credential-helper line protocol. On `get` it `connect()`s to `/run/generacy-control-plane/control.sock`, `POST`s `/git-token`, and prints `username=x-access-token\npassword=<token>\n` to stdout (FR-001, FR-012). `store`/`erase` are no-ops.
4. **Loud failure** — when the cloud pull is unreachable or returns non-2xx, the wrapper exits non-zero with a structured stderr message (`generacy-git-helper: <code>: <message>`). Git surfaces a clean failure (FR-008, SC-005).
5. **Telemetry** — control-plane emits structured log lines per `get` (cache hit / miss / refresh / error) and per cloud-pull attempt (FR-010).
6. **No background warmer** — pure synchronous-on-demand refresh per clarification Q4. Background timer deferred.

Companion cluster-base PR (generacy-ai/cluster-base#61) wires `git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy` and stops seeding `GH_TOKEN` into `~/.git-credentials` / `~/.netrc` (FR-006, FR-007). Cloud-side endpoint (generacy-cloud#817) is the blocking upstream.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=20 (control-plane currently targets Node 20+; CLI wrapper bundled with control-plane shares that runtime).
**Primary Dependencies**: `zod` (request/response schemas), `yaml` (existing, not new), `node:http` / `node:https` (cloud pull client), `node:net` (Unix-socket HTTP client in the CLI wrapper). No new runtime dependencies on the cluster image.
**Storage**: None added. Reads `/var/lib/generacy/cluster-api-key` (existing, written by `packages/orchestrator/src/activation/persistence.ts`). All token cache state is in-memory on the control-plane process; no on-disk token persistence (SC-002).
**Testing**: `vitest` (control-plane package, `__tests__/`). New tests for `GitTokenManager` (cache hit, pre-expiry refresh, concurrent-call collapsing, error path), the `POST /git-token` route (auth-key missing pre-activation, cloud error propagation), the CLI wrapper protocol (line-by-line stdin/stdout for `get`/`store`/`erase`), and the cloud-pull client (4xx/5xx/network error).
**Target Platform**: Linux cluster container (cluster-base / cluster-microservices). Node-only.
**Project Type**: single — control-plane service in the existing monorepo. Wrapper ships as an additional `bin/` from the same package.
**Performance Goals**:
- SC-001: zero auth failures across 4+ hour worker sessions.
- SC-003: ≥95% of `get` calls within a single token's lifetime served from cache.
- Cold-start `get` returns within ~1 cloud round-trip; cache-hit `get` returns within a single Unix-socket round-trip (sub-10 ms typical).
**Constraints**:
- No on-disk token caching — the file system must remain free of long-lived installation tokens (SC-002).
- No new persistent storage on the cluster side.
- Helper must be safe to invoke concurrently from many worker processes without thundering-herd against the cloud (FR-009).
- Helper is allowed to be unavailable pre-activation; failure mode is a clear stderr message, not a fallback to a static token (Q3, FR-008).
- All cluster git remotes target `github.com`; non-github remotes are out of scope. The credential-helper config in cluster-base uses `credential.https://github.com.helper` so non-github URLs bypass this helper entirely (FR-006, Assumptions).
**Scale/Scope**: Single control-plane process per cluster. N-of-1 token cache (single installation today; designed so adding more credentials later is a `Map<credentialId, CacheEntry>` change). Concurrent callers: ≤ ~10 simultaneous git ops in steady state, occasionally bursty at workflow start.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/766-summary-implement-git/
├── spec.md                                       # already authored
├── clarifications.md                             # already authored (Batch 1)
├── plan.md                                       # THIS FILE
├── research.md                                   # technology + pattern decisions
├── data-model.md                                 # types/interfaces for cache + cloud client + protocol
├── quickstart.md                                 # how to validate locally
└── contracts/
    ├── control-plane-git-token.schema.json       # POST /git-token request/response on the control socket
    ├── cloud-pull-endpoint.schema.json           # client-side view of generacy-cloud#817 contract
    └── git-credential-helper-protocol.md         # documented line-protocol the CLI wrapper implements
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (control-plane package — repository monorepo)

```text
packages/control-plane/
├── bin/
│   ├── control-plane.ts                          # MODIFIED — instantiate GitTokenManager, register it with the route module before server.start()
│   └── git-credential-generacy.ts                # NEW — CLI wrapper that speaks the git credential-helper line protocol over the control socket
├── src/
│   ├── routes/
│   │   └── git-token.ts                          # NEW — handlePostGitToken: validates body, calls GitTokenManager.getToken(), maps errors → JSON
│   ├── services/
│   │   ├── git-token-manager.ts                  # NEW — single-token in-memory cache, concurrent-call collapsing, sync pre-expiry refresh
│   │   ├── cloud-pull-client.ts                  # NEW — minimal node:https client for generacy-cloud#817; reads cluster API key from /var/lib/generacy/cluster-api-key
│   │   └── cluster-api-key.ts                    # NEW — small helper: read + cache the API key file with mtime invalidation
│   ├── router.ts                                 # MODIFIED — add POST /git-token route entry
│   ├── schemas.ts                                # MODIFIED — add GitTokenResponseSchema, CloudPullResponseSchema
│   └── types/
│       └── git-token.ts                          # NEW — GitTokenCacheEntry, CloudPullResult, GitCredentialResponse, GitHelperError types
├── __tests__/
│   ├── services/
│   │   ├── git-token-manager.test.ts             # NEW — cache hit / miss / pre-expiry refresh / concurrent collapse / cloud-error propagation
│   │   ├── cloud-pull-client.test.ts             # NEW — happy path, 4xx, 5xx, network error, missing API key
│   │   └── cluster-api-key.test.ts               # NEW — read + cache + mtime invalidation
│   ├── routes/
│   │   └── git-token.test.ts                     # NEW — route shape, error JSON, dispatch wiring
│   └── bin/
│       └── git-credential-generacy.test.ts       # NEW — end-to-end against a fake control socket: get / store / erase / non-github host / failure mode
└── package.json                                  # MODIFIED — add "git-credential-generacy" bin entry pointing at dist/bin/git-credential-generacy.js
```

**Structure Decision**: Single-project structure within the existing monorepo. All logic lives in `packages/control-plane` (per clarification Q1) — both the long-lived service and the per-invocation CLI wrapper ship from the same package. No new package. No cross-package coupling beyond reading the existing cluster API key file already owned by `packages/orchestrator/src/activation/`.

**Why no new package**: a standalone `packages/git-credhelper` (option C in Q1) would duplicate daemon + socket infrastructure for no benefit. The control socket and the cluster API key are already in this process; the wrapper is small enough that an extra published artifact would dwarf its actual code.

**Why not credhelper-daemon (Q1 option B)**: credhelper-daemon runs uid 1002 and is the local-secret server; it does not own the cloud relay connection nor the cluster API key. Moving git-auth there would require giving uid 1002 cloud access — strictly more surface for no benefit.

**Single-token vs Map cache**: today there is one `github-app` credential per cluster. `GitTokenManager` exposes its public API in terms of a credential identifier (`getToken(credentialId)`) so multi-credential support is a `Map` change, not a refactor of every call site. The v1 implementation may hold a single field internally; the surface area is forward-compatible.

**No fallback to static `GH_TOKEN`**: per FR-008 and clarification Q3, the helper does not silently fall back to the wizard-creds env file when the cloud is unreachable. Falling back would re-introduce the exact failure mode (#762) this work exists to eliminate.

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_ | _n/a_ | _n/a_ |
