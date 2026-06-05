# Tasks: Cluster-side JIT git credential helper

**Input**: Design documents from `/specs/766-summary-implement-git/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = long-running git ops; US2 = cache short-circuit; FN = foundation shared by both)

---

## Phase 1: Setup

- [X] T001 [FN] Add `"git-credential-generacy": "./dist/bin/git-credential-generacy.js"` to the `bin` field in `packages/control-plane/package.json`. Confirm `tsconfig.json` already compiles files under `bin/` (mirror existing `bin/control-plane.ts` pattern); add an entry if not.
- [X] T002 [P] [FN] Add the `git-token` channel/route constant placeholder (or confirm none is needed) and verify Zod is already a runtime dep of `packages/control-plane` — no new dependencies should be added per plan.md §Technical Context.

---

## Phase 2: Types & Schemas (foundations — must precede services)

- [X] T003 [P] [FN] Create `packages/control-plane/src/types/git-token.ts` with `GitTokenCacheEntry`, `GitHelperErrorCode` union, `GitHelperError` class, `CloudPullRequest`, `CloudPullResponse`, `GitTokenResponse` interfaces (per data-model.md §Entities).
- [X] T004 [P] [FN] Extend `packages/control-plane/src/schemas.ts` with `GitTokenRequestSchema` (optional `credentialId: string`), `GitTokenResponseSchema` (`{ token: string.min(1), expiresAt: string.datetime({ offset: false }) }`), and `CloudPullResponseSchema` (same shape). Match `contracts/control-plane-git-token.schema.json` and `contracts/cloud-pull-endpoint.schema.json`.
- [X] T005 [P] [FN] Confirm `packages/control-plane/src/errors.ts` `CredhelperErrorResponse`/error shape is reusable for git-token route errors; if not, add a small `GitTokenErrorResponse` matching `{ error, code, details? }` (see `contracts/control-plane-git-token.schema.json` `ErrorResponse`). *(Confirmed — `ControlPlaneErrorResponse` is `{ error, code, details? }` and is reused by the git-token route as a JSON envelope. The `GitHelperErrorCode` enum is distinct and mapped to HTTP statuses inside `routes/git-token.ts`.)*

---

## Phase 3: Unit tests (TDD — write failing tests before implementations in Phase 4)

- [X] T006 [P] [FN] Write `packages/control-plane/__tests__/services/cluster-api-key.test.ts`: covers first-read populates cache, second read hits cache (no stat re-read of contents), `mtime` change forces re-read, missing-file throws `GitHelperError(CLUSTER_API_KEY_MISSING)`. Use a tmpdir-backed fixture.
- [X] T007 [P] [FN] Write `packages/control-plane/__tests__/services/cloud-pull-client.test.ts`: spin up a temporary `node:https`/`node:http` server (loopback) and assert error-code mapping per research.md R-7 and contracts/cloud-pull-endpoint.schema.json `client_error_mapping`: happy path → `CloudPullResponse`; ECONNREFUSED → `CLOUD_UNREACHABLE`; 401 → `CLOUD_AUTH_REJECTED`; 400 → `CLOUD_REQUEST_INVALID`; 500 → `CLOUD_UPSTREAM_ERROR`; 200 + malformed body → `CLOUD_RESPONSE_INVALID`; 200 + already-past `expiresAt` → `CLOUD_RESPONSE_INVALID`; missing API key file → `CLUSTER_API_KEY_MISSING`.
- [X] T008 [P] [US2] Write `packages/control-plane/__tests__/services/git-token-manager.test.ts`: cold-start `get` calls cloud (refresh-success), warm `get` within validity returns cached entry (cache-hit, no cloud call), `get` inside 5-minute window of `expiresAt` triggers synchronous refresh, concurrent `get`s collapse to a single in-flight cloud call (assert cloud mock invoked once for N concurrent awaits — FR-009), cloud error is propagated as `GitHelperError` and cache is left empty (no stale-token fallback, data-model §Validation rule 3), `expiresAt > fetchedAt` invariant.
- [X] T009 [P] [US1] Write `packages/control-plane/__tests__/routes/git-token.test.ts`: `POST /git-token` returns 200 + `{ token, expiresAt }` on success; missing/invalid body still produces a token using default `github-app` credential; cloud-error from manager → 5xx with `{ error, code, details? }`; uses an injected fake `GitTokenManager` (no real cloud).
- [X] T010 [P] [US1] Write `packages/control-plane/__tests__/bin/git-credential-generacy.test.ts`: spin up a fake control-socket HTTP server on a temp Unix socket path, set `CONTROL_PLANE_SOCKET_PATH` env, spawn the wrapper binary as a child process for each test case. Cover (a) `get` happy path emits exact stdout from contracts/git-credential-helper-protocol.md §`get`; (b) `get` echoes `protocol`/`host` lines verbatim; (c) `get` with non-`github.com` host → exit 0, no stdout; (d) `store` and `erase` → exit 0, no stdout regardless of stdin; (e) control socket connect failure → exit 2, stderr `generacy-git-helper: CONTROL_SOCKET_UNREACHABLE: ...`; (f) each `code` returned by the route maps to its documented exit code (3..9) and stderr line (see exit-code table in contracts/git-credential-helper-protocol.md).

---

## Phase 4: Core service implementations (drive Phase 3 tests green)

- [X] T011 [FN] Implement `packages/control-plane/src/services/cluster-api-key.ts` exporting `createClusterApiKeyReader({ keyPath?: string })` → `ClusterApiKeyReader` with mtime-cached `read()`. Pattern mirrors `packages/orchestrator/src/services/wizard-creds-token-provider.ts` (research.md R-3). Default path `/var/lib/generacy/cluster-api-key`. Throws `GitHelperError('CLUSTER_API_KEY_MISSING', ...)` on ENOENT/EACCES. Drives T006 green.
- [X] T012 [FN] Implement `packages/control-plane/src/services/cloud-pull-client.ts` exporting `createCloudPullClient({ apiUrlEnv?, apiKeyReader, fetchImpl? })` → `{ pull(credentialId): Promise<CloudPullResponse> }`. Reads cloud base URL from `process.env.GENERACY_API_URL` (no `GENERACY_CLOUD_URL` fallback per CLAUDE.md Phase 4 Cleanup). Uses `node:https` (or `node:http` for local emulator URLs). Sends `Authorization: Bearer <cluster-api-key>`, `Content-Type: application/json`, `Accept: application/json`. Validates response body with `CloudPullResponseSchema`. Maps failures to `GitHelperErrorCode` per research.md R-7 / contracts/cloud-pull-endpoint.schema.json. Emits one structured `event: 'git-token-cloud-pull'` log per attempt (research.md R-9). No retries. Drives T007 green.
- [X] T013 [US2] Implement `packages/control-plane/src/services/git-token-manager.ts` exporting `createGitTokenManager({ cloudPullClient, now? })` → `GitTokenManager` with `getToken(credentialId)`. State: `cache: GitTokenCacheEntry | null`, `inFlight: Promise<GitTokenCacheEntry> | null`. Const `REFRESH_WINDOW_MS = 5 * 60_000`. Concurrent callers share the in-flight Promise (FR-009). Pre-expiry refresh triggers when `expiresAt - now <= REFRESH_WINDOW_MS` (FR-004). Emits `event: 'git-token-get'` log per call with `result: 'cache-hit' | 'refresh-success' | 'refresh-error'`, `credentialId`, `expiresAt`, `durationMs`, and `errorCode` on error (research.md R-9 — never logs the token). Drives T008 green.

---

## Phase 5: Route + CLI wrapper (depends on Phase 4)

- [X] T014 [US1] Create `packages/control-plane/src/routes/git-token.ts` exporting `handlePostGitToken({ gitTokenManager, defaultCredentialId })` Fastify-shaped handler matching the existing routes in `src/routes/credentials.ts` and `src/routes/lifecycle.ts`. Validate body with `GitTokenRequestSchema` (`credentialId` optional → falls back to `defaultCredentialId`). On success returns 200 + `GitTokenResponse`. On `GitHelperError` returns the existing control-plane error shape `{ error, code, details? }` mapped to a 5xx (or 4xx for `CREDENTIAL_NOT_CONFIGURED` / `CLUSTER_API_KEY_MISSING`). Drives T009 green.
- [X] T015 [US1] Register `POST /git-token` in `packages/control-plane/src/router.ts` (follow the existing pattern from `state.ts`, `credentials.ts`, `lifecycle.ts`).
- [X] T016 [US1] Create `packages/control-plane/bin/git-credential-generacy.ts`:
  - Read `action` from `process.argv[2]`. Valid values: `get`, `store`, `erase`. Any other value → exit 1 with `INTERNAL_ERROR` stderr line (defensive).
  - Stream stdin to EOF, parse `key=value` lines into a map. Capture `protocol` and `host`.
  - For `store`/`erase`: discard input, exit 0 with no stdout (contracts §`store`/`erase`).
  - For `get` with `host !== 'github.com'`: exit 0 with no stdout (contracts defensive bypass).
  - For `get` with `host === 'github.com'`: resolve socket via `process.env.CONTROL_PLANE_SOCKET_PATH ?? '/run/generacy-control-plane/control.sock'`. Use `node:http` with `{ socketPath, path: '/git-token', method: 'POST' }` to POST `{}` (server fills default credential).
  - On non-2xx or socket error → exit per the table in contracts/git-credential-helper-protocol.md §Exit code map. Stderr line: `generacy-git-helper: <code>: <message>\n`. Stdout: empty.
  - On 2xx success: echo `protocol=https\nhost=github.com\n` (echoing input verbatim per contracts §Rules), then `username=x-access-token\npassword=<token>\n`, then a blank line. Exit 0.
  - **Never log the token, even on error paths.** Drives T010 green.

---

## Phase 6: Wiring in the long-lived process

- [ ] T017 [FN] Modify `packages/control-plane/bin/control-plane.ts` to instantiate (in order): `clusterApiKeyReader = createClusterApiKeyReader()`, `cloudPullClient = createCloudPullClient({ apiKeyReader: clusterApiKeyReader })`, `gitTokenManager = createGitTokenManager({ cloudPullClient })`. Inject the manager into the route module before `server.start()`. Resolve the default `github-app` credential ID once at startup from `.agency/credentials.yaml` (mirror the pattern added in #762 `server.ts` for `githubAppCredentialId`); fall back to `'github-app'` literal when unresolved. Log structured `{ event: 'git-token-init', defaultCredentialId, apiUrlConfigured: boolean }` for diagnosability.

---

## Phase 7: Integration test (end-to-end against fake cloud + real binary)

- [ ] T018 [US1] [US2] Add `packages/control-plane/__tests__/integration/git-token-e2e.test.ts`: stand up a fake cloud HTTPS server, write a temp `cluster-api-key` file, boot the control-plane HTTP server bound to a temp Unix socket, then exercise:
  1. Real `git-credential-generacy get` against the live socket → success path, exit 0, expected stdout (validates SC-001 plumbing end-to-end).
  2. Two concurrent `git-credential-generacy get` invocations → fake cloud invoked exactly once (validates FR-009 across process boundary).
  3. Cloud server takes >5min jump (mock clock or short refresh window via DI) → second `get` triggers refresh (validates FR-004).
  4. Stop the fake cloud → wrapper exits 4 + stderr `CLOUD_UNREACHABLE` (validates SC-005 / FR-008).

---

## Phase 8: Polish

- [ ] T019 [P] [FN] Audit every log statement in the new files for "never log the token" invariant (data-model.md §Validation rule 1). Add a small lint or test-time assertion if convenient (e.g., a vitest `expect(stdoutCapture).not.toContain(testToken)` in T010 and T018).
- [ ] T020 [P] [FN] Update `packages/control-plane/README.md` (or the package's existing doc) with one paragraph describing the new endpoint and the `git-credential-generacy` bin, linking back to `specs/766-summary-implement-git/quickstart.md`. *(Skip entirely if no such README exists — do not create new docs.)*
- [ ] T021 [P] [FN] Update root `CLAUDE.md` "Cluster-side JIT Git Credential Helper" section to flip the language from PLANNED to LANDED once the implementation is in (preserve the existing entry's structure — paths, env vars, error codes).
- [ ] T022 [FN] Run `pnpm -F @generacy-ai/control-plane build && pnpm -F @generacy-ai/control-plane test` and confirm the new bin compiles to `dist/bin/git-credential-generacy.js` (per quickstart.md §Build) and all unit + integration tests pass.

---

## Dependencies & Execution Order

**Sequential boundaries**:
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8.
- Within Phase 4, T011 must complete before T012 (cloud-pull-client depends on `ClusterApiKeyReader`). T013 depends on T012 (manager depends on the client). T011 also blocks T012's test (T007 uses a fake API key file path but the production `createCloudPullClient` factory takes the reader DI).
- Phase 5: T015 depends on T014. T016 (CLI wrapper) is independent of T014/T015 in code but its integration test (T018, Phase 7) needs the route live.
- Phase 6 (T017) depends on Phase 5 (T014/T015) being importable.
- Phase 7 (T018) depends on T016 + T017 (real binary + real wiring).

**Parallel opportunities**:
- T003, T004, T005 can run in parallel (different files, all type-only).
- T006, T007, T008, T009, T010 can run in parallel — each is a separate test file with independent fixtures. They define behavior; their corresponding implementations land sequentially in Phase 4/5.
- T019, T020, T021 in Phase 8 are independent polish tasks and can be done concurrently.

**Critical path** (longest dependency chain):
T001 → T003 → T006 → T011 → T007 → T012 → T008 → T013 → T009 → T014 → T015 → T017 → T010 → T016 → T018 → T022.

**Out-of-scope for this repo** (do not include in tasks):
- `git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy` wiring → companion PR generacy-ai/cluster-base#61.
- Removal of `GH_TOKEN` from `~/.git-credentials` / `~/.netrc` → companion PR generacy-ai/cluster-base#61.
- Cloud on-demand pull endpoint implementation → blocking upstream generacy-ai/generacy-cloud#817.

---

*Generated by speckit /tasks (standard mode)*
