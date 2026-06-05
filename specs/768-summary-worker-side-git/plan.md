# Implementation Plan: Worker-side git-token proxy bin

**Feature**: Move the worker-side `git-token-proxy` from a loose script in cluster-base into `@generacy-ai/control-plane` as a typed, tested, versioned bin. Single-route allow-list forwards `POST /git-token` to the control-plane upstream socket; 404s everything else.
**Branch**: `768-summary-worker-side-git`
**Status**: Complete
**Date**: 2026-06-05
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/768-summary-worker-side-git/spec.md`

## Summary

The worker-side proxy currently lives in cluster-base as `.devcontainer/generacy/scripts/git-token-proxy.js` — a ~138-line standalone Node script. It is a **privilege boundary**: it deliberately exposes only `POST /git-token` to workers (uid 1001 / `node` group), 404s everything else, and never silently falls back to a stale token. Land it in the same package as the route it forwards to so it's type-checked, unit-tested, and version-locked.

1. **New bin** — ship `packages/control-plane/dist/bin/git-token-proxy.js` (mirrors the `git-credential-generacy` bin already in this package). Add a second entry to the `bin` field of `package.json`.
2. **Pure-function core** — extract the single-route allow-list, the request-header allow-list (content-type / content-length only), and the upstream-error mapping into pure functions. Test them cross-platform with vitest. Per clarification Q4.
3. **Thin entry point** — the bin itself wires `net.createServer` → `http.Server` over the listen socket, calls into the pure functions on every request, forwards to the upstream control socket. Stale-socket cleanup on boot, `0660` mode on bind, `SIGTERM`/`SIGINT` graceful shutdown. No `mkdir` of the parent directory — cluster-base owns the tmpfs (clarification Q1).
4. **Bounded** — 64 KiB request-body cap (413 on overflow), 30s upstream-response timeout (mapped to `502 CONTROL_SOCKET_UNREACHABLE`). Per clarification Q5.
5. **Structured logging** — two JSON events on stdout: `{ event: 'git-token-proxy-init', listenSocket, upstreamSocket }` at start, `{ event: 'git-token-proxy-upstream-error', code }` on each upstream failure. **Nothing else** — never log bodies, headers, or tokens. Per clarification Q3.
6. **Tests** — pure-function vitest tests for the route allow-list, header allow-list, body-cap, and upstream-error mapping. Plus one real Unix-socket smoke test covering bind, `0660` socket mode, single-route enforcement on the wire, and `SIGTERM` cleanup (skipped automatically on non-POSIX). Per clarification Q4.

Companion cluster-base PR (already in flight) updates `entrypoint-orchestrator.sh` to launch `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js` and removes the bundled script. Land this issue first so that PR has the bin to point at.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=20 (matches `packages/control-plane` `engines.node`). Compiles to ESM (`"type": "module"`) under `dist/bin/`.
**Primary Dependencies**: Node built-ins only — `node:http`, `node:net`, `node:fs`, `node:fs/promises`, `node:path`. **No new runtime deps.** No `zod` (the bin doesn't parse bodies — it forwards them).
**Storage**: None. The bin is stateless. It does **not** read `/var/lib/generacy/cluster-api-key`, `.agency/credentials.yaml`, or any other on-disk state — that is the upstream control-plane's job (#766 / `git-token-manager.ts`). The proxy only mediates the Unix-socket boundary between worker and orchestrator processes.
**Testing**: `vitest` in `packages/control-plane/__tests__/bin/`. Pure-function tests for the security-critical logic (cross-platform, fast). One real Unix-socket smoke test gated on `process.platform !== 'win32'` (`it.skipIf(...)` or equivalent) covering bind / mode / wire-level allow-list / shutdown.
**Target Platform**: Linux cluster container (cluster-base / cluster-microservices). The bin runs in the orchestrator container alongside control-plane and code-server. Workers reach it from a peer container over a shared `tmpfs` mount.
**Project Type**: single — extends the existing `packages/control-plane` monorepo package. No new package, no cross-package coupling.
**Performance Goals**:
- Cold-start: bind in < 50 ms after spawn.
- Per-request overhead introduced by the proxy: < 5 ms (single Unix-socket hop, no parse/serialize of body).
- Body cap (64 KiB) is generous against the real `{}` payload (2 bytes) — there is no practical performance pressure.
**Constraints**:
- **Single-route privilege boundary.** Only `POST /git-token` is forwarded. Everything else (other paths, other methods on `/git-token`) returns 404 with no upstream contact. The allow-list is the security primitive and must be unit-tested.
- **Header allow-list.** Only `content-type` and `content-length` are passed to upstream. `host`, `authorization`, `accept`, every `x-*`, every cookie, every range header — stripped. Workers must not be able to inject headers that influence upstream behavior.
- **Loud failure.** Upstream socket unreachable / timeout / connection-reset → respond `502` with body `{ error, code: 'CONTROL_SOCKET_UNREACHABLE' }`. Never silently fall back to a static token; never serve a stale 200.
- **No on-disk state.** The proxy carries no secrets, no cache, no rate-limit table. Restarting it loses nothing.
- **No parent-directory creation.** Bind failure surfaces as a structured stderr line that names the missing path; the bin does not `mkdir`. Cluster-base entrypoint owns the tmpfs mount lifecycle (clarification Q1).
- **No process-level fall-through to `GH_TOKEN`.** Same loud-failure ethos as #762 / #766.
**Scale/Scope**: One proxy process per cluster (in the orchestrator container). Burst: O(10) concurrent worker `git` ops at workflow start; steady state: very low. No connection pooling needed — `http.Agent` defaults serve fine over a Unix socket.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/768-summary-worker-side-git/
├── spec.md                                          # already authored
├── clarifications.md                                # already authored (Batch 1)
├── plan.md                                          # THIS FILE
├── research.md                                      # technology + pattern decisions
├── data-model.md                                    # types/interfaces for forwarder + error mapping
├── quickstart.md                                    # how to validate locally
└── contracts/
    ├── git-token-proxy.schema.json                  # wire contract (worker → proxy) — the same shape as control-plane /git-token, plus the 502/404 boundaries
    └── proxy-bin-cli.md                             # documented CLI invocation, env vars, exit semantics
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (control-plane package — repository monorepo)

```text
packages/control-plane/
├── bin/
│   ├── control-plane.ts                             # unchanged in this feature
│   ├── git-credential-generacy.ts                   # unchanged in this feature
│   └── git-token-proxy.ts                           # NEW — thin entry: parses env, creates server, wires SIGTERM, calls into the pure helpers in src/git-token-proxy/
├── src/
│   └── git-token-proxy/
│       ├── index.ts                                 # NEW — barrel re-export of the public-to-tests API
│       ├── handler.ts                               # NEW — pure-function request handler: route allow-list, header allow-list, body cap, upstream call, error mapping. Takes injected http.request factory for testability.
│       ├── allowlists.ts                            # NEW — exported pure functions: isAllowedRoute(method, path), pickAllowedHeaders(headers). Tested in isolation.
│       ├── upstream-errors.ts                       # NEW — pure function mapErrorToCode(err): 'CONTROL_SOCKET_UNREACHABLE' for ECONNREFUSED / ENOENT / EPIPE / timeout / etc. Single source of truth for the only error code this bin emits.
│       └── logging.ts                               # NEW — structured-log helpers: logProxyInit({ listenSocket, upstreamSocket }), logUpstreamError({ code }). Stdout only. NEVER includes headers, bodies, or tokens.
├── __tests__/
│   └── bin/
│       ├── git-credential-generacy.test.ts          # unchanged
│       └── git-token-proxy/
│           ├── handler.test.ts                      # NEW — pure-function tests: 404 on non-/git-token paths, 404 on GET /git-token, header allow-list strips Authorization/Host/X-*, 413 on > 64 KiB body, 502 on upstream failure, 200 passthrough on success
│           ├── allowlists.test.ts                   # NEW — isAllowedRoute and pickAllowedHeaders exhaustive cases
│           ├── upstream-errors.test.ts              # NEW — ECONNREFUSED / ENOENT / EPIPE / timeout / generic — all map to CONTROL_SOCKET_UNREACHABLE
│           └── lifecycle.smoke.test.ts              # NEW — real Unix-socket smoke test: bind in tmp dir, fake upstream socket in tmp dir, 0660 mode on listen socket, single-route enforcement on the wire, SIGTERM cleans up the socket file. Skipped on non-POSIX.
├── package.json                                     # MODIFIED — bin field gains "git-token-proxy": "./dist/bin/git-token-proxy.js"
└── tsconfig.json                                    # unchanged (bin/ already in include)
```

**Structure Decision**: Single-package extension. All new code lives in `packages/control-plane` under a new `src/git-token-proxy/` directory and a sibling `bin/git-token-proxy.ts`. The pure functions in `src/git-token-proxy/` are exported (and barrel-exported via `index.ts`) so vitest can import them directly; the bin entry point is the only file that calls `net.createServer`, `process.on('SIGTERM', …)`, and `process.exit()`.

**Why a new `src/git-token-proxy/` subdirectory and not a single file**: separating `allowlists.ts`, `upstream-errors.ts`, `handler.ts`, and `logging.ts` lets each file have a single responsibility, lets each have its own focused test file, and lets the pure functions be re-imported by the smoke test without dragging in the bin's process-management code. This mirrors the layered split already used in `src/services/git-token-manager.ts` + `src/services/cloud-pull-client.ts` + `src/services/cluster-api-key.ts` (#766).

**Why not a new package**: option-rejection mirrors #766 R-1 — duplicating publishing and CI for ~200 LOC of glue is not justified, and the bin's runtime contract (the `POST /git-token` route on the control socket) is owned by this package. Co-location is the version-lock mechanism.

**Why not credhelper-daemon**: credhelper-daemon (uid 1002) is the local-secret server and does not own the cluster API key or the cloud connection. The proxy doesn't need either — it just forwards bytes — but it is functionally part of the control-plane HTTP surface, so it belongs in the same package.

**No new runtime dependency**: the bin uses only Node built-ins. `zod` is not pulled in — the proxy never parses the body (it forwards the raw bytes after enforcing the size cap), and the only outbound error response is a fixed-shape `{ error, code }` literal. Avoiding `zod` keeps the bin's cold-start small (per-request overhead is dominated by Node startup if invoked as a one-shot, though it actually runs as a long-lived process).

**Test split rationale (clarification Q4)**: the privilege boundary is the route + header allow-list, the body cap, and the error mapping. Those are pure functions, so we test them as pure functions — fast, deterministic, cross-platform, and the test file reads as a literal allow-list spec. The lifecycle behavior (`net.createServer({path})`, `chmod 0660`, `unlink` on stale socket, signal handling) is a separate concern with platform-specific behavior, so we cover it once with a real-Unix-socket smoke test that runs only on POSIX. Better targeted coverage than all-mock (misses the wire shape) or all-integration (slow, platform-gated, hard to reason about).

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_ | _n/a_ | _n/a_ |
