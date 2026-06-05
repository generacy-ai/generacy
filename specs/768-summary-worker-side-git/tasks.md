# Tasks: Worker-side git-token proxy bin (#768)

**Input**: Design documents from `/specs/768-summary-worker-side-git/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = port proxy as a tested, version-locked bin in `@generacy-ai/control-plane`)

## Phase 1: Setup

- [X] T001 Create directory skeleton: `packages/control-plane/src/git-token-proxy/` and `packages/control-plane/__tests__/bin/git-token-proxy/` (no contents yet — just the dirs the rest of the tasks write into).
- [X] T002 [P] [US1] Update `packages/control-plane/package.json` `bin` field: add `"git-token-proxy": "./dist/bin/git-token-proxy.js"` alongside the existing `control-plane` and `git-credential-generacy` entries. Do NOT add any new runtime dependency (per plan: Node built-ins only).

## Phase 2: Pure-function core (the privilege boundary)

These are the security-critical, cross-platform, dependency-free units. Land them with their tests so the boundary is wired before the bin shells in.

- [X] T003 [P] [US1] Create `packages/control-plane/src/git-token-proxy/allowlists.ts` exporting two pure functions per data-model.md §`RouteAllowList` and §`HeaderAllowList`:
  - `isAllowedRoute(method: string | undefined, url: string | undefined): boolean` — only `POST /git-token` returns true; query string stripped before comparison; trailing slash significant; undefined inputs return false.
  - `pickAllowedHeaders(headers: http.IncomingHttpHeaders): Record<string, string>` — returns a new object containing only lowercase `content-type` and `content-length` from the input (case-insensitive on input). Every other key is dropped.
- [X] T004 [P] [US1] Create `packages/control-plane/src/git-token-proxy/upstream-errors.ts` exporting:
  - `type UpstreamErrorCode = 'CONTROL_SOCKET_UNREACHABLE'`.
  - `mapUpstreamErrorToCode(err: unknown): UpstreamErrorCode` — identity-style mapper that collapses every input (ECONNREFUSED, ENOENT, ECONNRESET, EPIPE, timeout/AbortError, generic Error) to `'CONTROL_SOCKET_UNREACHABLE'`. Single source of truth per data-model.md §`UpstreamErrorCode`.
- [X] T005 [P] [US1] Create `packages/control-plane/src/git-token-proxy/logging.ts` exporting exactly two functions per data-model.md §`LogEvent`:
  - `logProxyInit({ listenSocket, upstreamSocket }): void` → `console.log(JSON.stringify({ event: 'git-token-proxy-init', listenSocket, upstreamSocket }))`.
  - `logUpstreamError({ code }): void` → `console.log(JSON.stringify({ event: 'git-token-proxy-upstream-error', code }))`.
  - No other exports. No spread, no dynamic keys, no body/header/token in either payload (validation rule #1).
- [X] T006 [US1] Create `packages/control-plane/src/git-token-proxy/handler.ts` — pure-function request handler. Depends on T003, T004, T005.
  - Export `MAX_BODY_BYTES = 64 * 1024`, `UPSTREAM_TIMEOUT_MS = 30_000` constants (per data-model.md §Constants).
  - Export `createHandler({ upstreamSocketPath, httpRequest = http.request }): (req, res) => void` — factory with DI of `http.request` so tests can stub upstream.
  - Behavior per data-model.md §Steady state: call `isAllowedRoute` first (404 + no upstream contact on reject); buffer body up to `MAX_BODY_BYTES` (413 + `PAYLOAD_TOO_LARGE` JSON on overflow); rebuild outbound headers with `pickAllowedHeaders` and overwrite `content-length` with `String(body.length)`; open `httpRequest({ socketPath, method: 'POST', path: '/git-token', headers })` with `setTimeout(UPSTREAM_TIMEOUT_MS, ...)`; on `'response'` pipe upstream status+headers+body verbatim to the client; on `'error'` (or timeout) call `mapUpstreamErrorToCode`, `logUpstreamError`, and respond `502` with `{ error: 'control-plane upstream unreachable', code: 'CONTROL_SOCKET_UNREACHABLE' }`.
- [X] T007 [P] [US1] Create `packages/control-plane/src/git-token-proxy/index.ts` barrel: re-export `isAllowedRoute`, `pickAllowedHeaders`, `mapUpstreamErrorToCode`, `createHandler`, `MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS`, `logProxyInit`, `logUpstreamError`, and the `UpstreamErrorCode` type. Tests import from this barrel.

## Phase 3: Pure-function tests

Land alongside Phase 2 so the privilege boundary is exercised before the bin entry point. All four files are independent — fully parallel.

- [X] T008 [P] [US1] Create `packages/control-plane/__tests__/bin/git-token-proxy/allowlists.test.ts` per data-model.md §`RouteAllowList` and §`HeaderAllowList` test policies:
  - `isAllowedRoute` positive cases: `POST /git-token`, `POST /git-token?x=y`. Negative cases: `GET /git-token`, `POST /git-token/`, `POST /git-tokens`, `POST //git-token`, `POST /credentials/x`, `POST /lifecycle/bootstrap-complete`, `OPTIONS /git-token`, undefined method, undefined url.
  - `pickAllowedHeaders` exhaustive: dirty input including `host`, `authorization`, `accept`, `cookie`, `x-real-ip`, `x-forwarded-for`, `range`, `if-none-match`, `user-agent`, custom `x-anything` — all dropped. `Content-Type` and `CONTENT-LENGTH` (mixed case) preserved as lowercase keys.
- [X] T009 [P] [US1] Create `packages/control-plane/__tests__/bin/git-token-proxy/upstream-errors.test.ts`: assert `mapUpstreamErrorToCode` returns `'CONTROL_SOCKET_UNREACHABLE'` for representative inputs — `Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })`, `{ code: 'ENOENT' }`, `{ code: 'ECONNRESET' }`, `{ code: 'EPIPE' }`, `new Error('timeout')` (AbortError shape), `new Error('generic')`, and `undefined`.
- [X] T010 [P] [US1] Create `packages/control-plane/__tests__/bin/git-token-proxy/handler.test.ts` — pure-function tests for `createHandler` using an injected `http.request` stub. Cover:
  - 404 on `GET /git-token` (and on `POST /credentials/x`) with **zero** calls to the injected `httpRequest` (validation rule #3).
  - 413 + `{ error, code: 'PAYLOAD_TOO_LARGE' }` when body length > `MAX_BODY_BYTES`; upstream not contacted.
  - On success: the headers passed to `httpRequest` contain only lowercase `content-type` and `content-length`; `content-length` equals the buffered body length (validation rule #5); upstream `Authorization`/`X-*`/`Host` from the inbound request are NOT present (validation rule #4).
  - On stubbed upstream `'error'` event: response is `502` with `{ error, code: 'CONTROL_SOCKET_UNREACHABLE' }` and `logUpstreamError` was called exactly once (use `vi.spyOn(console, 'log')`).
  - On 2xx from upstream: status, headers, and body are piped through verbatim.
- [X] T011 [P] [US1] Create `packages/control-plane/__tests__/bin/git-token-proxy/logging.test.ts`: assert `logProxyInit` and `logUpstreamError` each call `console.log` exactly once with `JSON.stringify(<the exact literal>)`; no other console method invoked; no field beyond the closed shape (validation rule #1).

## Phase 4: Bin entry point (the thin process-management shell)

- [X] T012 [US1] Create `packages/control-plane/bin/git-token-proxy.ts`. Depends on T006, T007. Per data-model.md §Lifecycle and contracts/proxy-bin-cli.md:
  - Read env: `GIT_TOKEN_PROXY_SOCKET` (default `/run/generacy-git-token/control.sock`), `CONTROL_PLANE_SOCKET_PATH` (default `/run/generacy-control-plane/control.sock`). No other env consumed.
  - On startup, `fs.unlink(listenSocketPath)` (ignore ENOENT; EBUSY/EPERM fatal). Do NOT `mkdir` the parent (clarification Q1) — bind failure surfaces as a structured stderr line `git-token-proxy: bind failed: <path>: <code>` and exits 1.
  - `http.createServer(createHandler({ upstreamSocketPath }))` and `server.listen({ path: listenSocketPath })`.
  - After successful listen: `fs.chmod(listenSocketPath, 0o660)` — failure prints `git-token-proxy: chmod failed: <path>: <code>` to stderr and exits 1 (privilege-boundary correctness).
  - Then call `logProxyInit({ listenSocket, upstreamSocket })` (per contract: emitted exactly once, after chmod succeeds).
  - Register `SIGTERM` and `SIGINT`: start a `SHUTDOWN_TIMEOUT_MS = 5_000` timer that `process.exit(1)` if shutdown stalls; `server.close()`; `fs.unlink(listenSocketPath).catch(noop)`; `process.exit(0)`.
  - No subcommands, no flags, no positional arg parsing. No on-disk state read beyond the unlink+chmod calls. No `GH_TOKEN` fallback.

## Phase 5: Smoke test (real Unix socket)

- [X] T013 [US1] Create `packages/control-plane/__tests__/bin/git-token-proxy/lifecycle.smoke.test.ts`. POSIX-only — gate the whole describe with `describe.skipIf(process.platform === 'win32')`. Depends on T012.
  - Spawn the built bin with `GIT_TOKEN_PROXY_SOCKET` and `CONTROL_PLANE_SOCKET_PATH` pointing at paths under `os.tmpdir()`. Start a tiny `http.createServer` on `CONTROL_PLANE_SOCKET_PATH` as fake upstream.
  - Wait for the `git-token-proxy-init` JSON line on the child's stdout (proves bind + chmod succeeded).
  - Assert `(fs.statSync(listenSocket).mode & 0o777) === 0o660` (validation rule #7 and contract requirement).
  - Send `POST /git-token` over the listen socket via `http.request({ socketPath })` → expect 200 and the upstream's body.
  - Send `GET /git-token` and `POST /credentials/x` over the same socket → expect 404 from the proxy, with no request observed by the upstream.
  - Send `SIGTERM` to the child; wait for exit code 0; assert the listen socket file no longer exists.

## Phase 6: Wire-up and verification

- [X] T014 [US1] Run `pnpm -F @generacy-ai/control-plane build` and confirm `packages/control-plane/dist/bin/git-token-proxy.js` exists with a Node shebang (or that the bin is executed via `node …` in the cluster-base launcher — the dist file is the integration point for the companion cluster-base PR).
- [X] T015 [US1] Run `pnpm -F @generacy-ai/control-plane test` and confirm all five new test files pass (4 pure-function + 1 smoke). No regressions in `git-credential-generacy.test.ts` or other existing control-plane tests.
- [X] T016 [P] [US1] Walk through quickstart.md §"Run the bin locally (out-of-cluster)" steps 1–7 against the freshly built bin and confirm each numbered curl produces the documented response (200 passthrough, 404 on wrong method/path/trailing-slash, 413 on > 64 KiB body, 502 `CONTROL_SOCKET_UNREACHABLE` when upstream stopped, socket file gone after Ctrl-C). This is the manual acceptance gate; not a CI task.

## Dependencies & Execution Order

**Phase 1** (T001, T002) is trivial setup — run first, both parallel-safe.

**Phase 2 → handler depends on the leaves:**
- T003, T004, T005 are independent of each other and can land in any order or in parallel (different files).
- T006 (handler.ts) imports from T003/T004/T005 — must follow them.
- T007 (barrel) imports from T003/T004/T005/T006 — must follow T006.

**Phase 3** tests can be drafted in parallel with their corresponding Phase 2 source (T008↔T003, T009↔T004, T010↔T006, T011↔T005), but T010 needs `createHandler`'s shape, so practically: write T008/T009/T011 in parallel with their leaves; write T010 after T006.

**Phase 4** (T012) depends on T006 (handler) and T007 (barrel). It is one file by itself; no parallelism.

**Phase 5** (T013) depends on T012 *and* on the dist output being buildable. Run after T014 in practice, since the smoke test spawns the built bin.

**Phase 6**:
- T014 (build) gates T013 and T015.
- T015 (test) follows the build.
- T016 (manual quickstart walk-through) can run any time after T014 — fully parallel with T015.

**Suggested parallel batches:**
- Batch A (Phase 1 + Phase 2 leaves): T001, T002, T003, T004, T005 — five tasks, all in parallel.
- Batch B (Phase 2 composition): T006 → T007 — sequential.
- Batch C (Phase 3 tests, drafted alongside Batch A): T008, T009, T011 in parallel; T010 after T006.
- Batch D (Phase 4): T012 — single task.
- Batch E (Phase 5 + 6): T014 → T013 + T015 + T016 in parallel.

## Notes

- **No new runtime dependencies.** The bin and its tests use only Node built-ins plus the existing `vitest` devDep. Do not introduce `zod` here — the proxy does not parse bodies (plan §Technical Context).
- **No body parsing in the handler.** The 64 KiB cap is enforced as a byte count on the buffer; `JSON.parse` is forbidden in handler.ts (validation rule #2).
- **No token in logs, ever.** All log lines come from `logging.ts`, which exports closed-shape helpers. Any new log statement in handler.ts or the bin entry MUST use these helpers (validation rule #1, contract §Stdout).
- **Companion cluster-base PR is out of scope here.** This issue ships the bin; SC-002 ("0 static git tokens on disk in the orchestrator container") is met once the companion lands. Land this first.
