# Tasks: JIT GH-CLI Token Provider (#773)

**Input**: Design documents from `/specs/773-severity-high-issue-processing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/jit-git-token-client.md, contracts/jit-token-provider.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (this PR is single-story — US1 = "gh-CLI consumers never hit the 1h 401 cliff")

## Phase 1: Shared client (`packages/control-plane`)

- [X] T001 [US1] Create `packages/control-plane/src/services/jit-git-token-client.ts` with `JitGitTokenClient` interface, `JitGitTokenClientOptions`, `JitGitTokenResponse`, `JitTokenError` class, `JitTokenErrorCode` union (per contracts/jit-git-token-client.md §TypeScript surface), and `createJitGitTokenClient()` factory. Implementation reuses the `node:http` Unix-socket POST pattern from `packages/control-plane/bin/git-credential-generacy.ts:66-91`. Apply the failure-mode table from contracts §"Failure modes (no HTTP response)" exactly. No caching, no retry, no logging at info-level.

- [X] T002 [P] [US1] Add re-exports to `packages/control-plane/src/index.ts`: `JitGitTokenClient`, `JitGitTokenClientOptions`, `JitGitTokenResponse`, `JitTokenError`, `JitTokenErrorCode`, `createJitGitTokenClient`. Match existing `ControlPlaneError` / `CodeServerProcessManager` re-export convention.

- [X] T003 [P] [US1] Write unit tests at `packages/control-plane/src/services/__tests__/jit-git-token-client.test.ts` covering all 12 cases in contracts/jit-git-token-client.md §Tests (happy path; 400/502/503 mapped error codes; non-JSON body; missing `token`; bogus `expiresAt`; unknown error code → `CLOUD_UPSTREAM_ERROR`; empty body on error; socket missing; mid-stream EPIPE; `credentialId` provided body shape; `credentialId` omitted body shape). Use `net.createServer` Unix-socket fixture in tmp dir, following existing convention in `packages/control-plane/__tests__/bin/git-credential-generacy/`.

## Phase 2: Refactor the existing bin to use the shared client

- [X] T004 [US1] Refactor `packages/control-plane/bin/git-credential-generacy.ts` to delegate to `JitGitTokenClient` instead of its inline `http.request` block (lines ~66-91). Preserve the existing `EXIT_CODE_BY_CODE` table mapping `JitTokenErrorCode` → CLI exit code; map `CONTROL_SOCKET_UNREACHABLE` and `RESPONSE_PARSE_ERROR` to existing distinct exit codes (extend the table if needed — keep numbers stable for codes that already exist). Add `GIT_TOKEN_SOCKET_PATH` to the env-var resolution chain (currently the bin only honors `CONTROL_PLANE_SOCKET_PATH`) for parity with the orchestrator wrapper.

- [X] T005 [P] [US1] Update / extend existing bin tests at `packages/control-plane/__tests__/bin/git-credential-generacy/` to confirm: (a) wire-level behavior unchanged from a user's perspective (line protocol output identical for `get`/`store`/`erase`); (b) new env-var precedence `GIT_TOKEN_SOCKET_PATH > CONTROL_PLANE_SOCKET_PATH > default` honored; (c) `JitTokenErrorCode` from the shared client is translated to the existing CLI exit codes correctly. Do NOT duplicate the socket-failure matrix from T003 — that's the client's contract; this is integration.

## Phase 3: Provider (`packages/orchestrator`)

- [X] T006 [US1] Create `packages/orchestrator/src/services/jit-github-token-provider.ts` with `JitGithubTokenProvider` type alias, `JitGithubTokenProviderOptions` interface, `createJitGithubTokenProvider()` factory, and `resolveSocketPath()` helper (per contracts/jit-token-provider.md §TypeScript surface). Implement: in-process `Map<credentialId, TokenCacheEntry>` cache; 5-min default refresh window matching `GitTokenManager.REFRESH_WINDOW_MS`; cache-hit short-circuit; cache-miss + within-refresh-window refetch; on `client.fetch()` failure call `authHealth?.recordResult(credentialId, { ok: false, statusCode: 503 })` (wrapped in try/catch so sink errors don't mask original) and re-throw; non-`JitTokenError` wrapped as `JitTokenError('CONTROL_SOCKET_UNREACHABLE', err.message)`; discard stale cache entry on refresh failure (per contract §"Cache invalidation on failure"). Never return `undefined`/`null`/`''` — TS return type `Promise<string>` enforces statically; add one runtime assertion in test.

- [X] T007 [P] [US1] Write unit tests at `packages/orchestrator/tests/unit/services/jit-github-token-provider.test.ts` covering all 15 cases in contracts/jit-token-provider.md §Tests (first call fetches; cache hit; refresh-window hit; expired refetch; `JitTokenError` propagation + sink reporting; non-`JitTokenError` wrap; stale entry discard; undefined sink; sink throws; custom `refreshWindowMs`; injected `now()`; concurrent miss; `resolveSocketPath` precedence × 4 env permutations; never-returns-undefined invariant). Mock `JitGitTokenClient` directly — do NOT spin up a socket fixture here (that's covered by T003).

## Phase 4: Wire into server.ts

- [X] T008 [US1] In `packages/orchestrator/src/server.ts`: move the `githubAppCredentialId` resolution (currently lines ~195-203, `readCredentialDescriptors` call) earlier in the file, **before** line ~160 where the token provider is constructed. Verify no other code between the original and new position depends on `githubAppCredentialId` being undefined at the earlier point.

- [X] T009 [US1] In `packages/orchestrator/src/server.ts`: replace the `createWizardCredsTokenProvider(...)` call at line ~160 with `createJitGitTokenClient({ socketPath: resolveSocketPath() })` + `createJitGithubTokenProvider({ client, credentialId: githubAppCredentialId, authHealth: githubAuthHealth ?? undefined, logger: server.log })`. Drop the `!isWorkerMode` guard — provider must be constructed in both modes (`ClaudeCliWorker` at line ~298 is inside `if (isWorkerMode)` and needs it). Update the import at line ~30: drop `createWizardCredsTokenProvider`, add `createJitGithubTokenProvider` + `resolveSocketPath` from local services + `createJitGitTokenClient` from `@generacy-ai/control-plane`. When `githubAppCredentialId` is undefined, the provider variable stays `undefined` and existing fall-through to ambient `GH_TOKEN` is preserved (matches today's behavior for unconfigured clusters).

- [X] T010 [US1] In `packages/orchestrator/src/server.ts`: swap the variable name `wizardCredsTokenProvider` → `githubTokenProvider` at the five gh-CLI callsites: line ~207 `LabelSyncService` (3rd ctor arg), line ~298 `ClaudeCliWorker` `deps.tokenProvider`, line ~335 `LabelMonitorService` (8th ctor arg), line ~363 `PrFeedbackMonitorService` (8th ctor arg), line ~616 `WebhookSetupService` (2nd ctor arg). Pure rename — no signature changes at the callee side because `Promise<string>` is assignable to `Promise<string | undefined>` in `GhCliGitHubClient.tokenProvider`.

## Phase 5: Delete the static provider

- [X] T011 [P] [US1] Delete `packages/orchestrator/src/services/wizard-creds-token-provider.ts`. Confirm via grep that no in-tree import remains (all six server.ts references replaced by T008-T010; no other consumers).

- [X] T012 [P] [US1] Delete `packages/orchestrator/tests/unit/services/wizard-creds-token-provider.test.ts`. If any other test file imports `TokenProvider` from this module, update those imports to the new `jit-github-token-provider.ts` location (the new file exports `JitGithubTokenProvider` as a structurally identical alias).

## Phase 6: Validation

- [ ] T013 [US1] Run `pnpm -r typecheck` and `pnpm -r test` from repo root. Confirm: zero TS errors, all existing tests still pass, new tests from T003/T005/T007 pass. Specifically: orchestrator `gh-cli.ts` typechecks against the tightened `() => Promise<string>` provider signature (passes because it's assignable to `() => Promise<string | undefined>`).

- [ ] T014 [US1] Manual soak verification per quickstart.md §"How to verify the fix" → §Manual: launch a cluster, complete wizard, run `while true; do gh api rate_limit | jq '.rate.remaining'; sleep 60; done` from inside an orchestrator container for >1h. Expect zero 401s.

- [ ] T015 [US1] Manual negative-path verification per quickstart.md §"Failure-mode injection (negative test)": with cluster running and worker mid-cycle, `docker compose stop control-plane`; expect (a) worker logs structured warn with `code: 'CONTROL_SOCKET_UNREACHABLE'`, (b) gh subprocess does NOT run (no 401 round-trip), (c) `cluster.credentials` relay channel emits `auth-failed` then `refresh-requested` within seconds.

## Dependencies & Execution Order

**Sequential chains** (must complete in order):

- T001 → T002 (re-exports depend on the file existing)
- T001 → T004 (bin refactor depends on the shared client)
- T001 → T006 (provider depends on the shared client)
- T006 → T008 → T009 → T010 (server.ts changes are sequential — same file, ordered semantically)
- T009 + T010 → T011 (deleting the old provider requires all callsites swapped)
- T010 → T012 (test deletion follows source deletion)
- All implementation tasks → T013 (validation runs against the full change)
- T013 → T014 → T015 (soak and negative tests presuppose a green build)

**Parallel opportunities** within Phase 1-2-3:

- T002, T003 parallel after T001 lands (different files, no dep between re-exports and tests)
- T005 parallel with T004 once T001 is done (different test file from the impl)
- T007 parallel with T006 once impl skeleton + types exist (mock-based tests; can be written in parallel with implementation under TDD; otherwise sequential)

**Parallel opportunities** within Phase 5:

- T011 and T012 parallel (different files)

**Phase 4 is fully sequential** — every task touches `server.ts`.

**Phase 6 is gating** — do not declare done until T015 passes in a real cluster.

## Out-of-scope (deferred follow-ups)

These were explicitly excluded by spec/clarifications:

- Retire the `GH_TOKEN=...` line in `wizard-env-writer.ts` / `/var/lib/generacy/wizard-credentials.env` — separate audit issue (Q1).
- Multi-credential support (multiple `github-app` entries) — `Map<credentialId, …>` shape is ready but only one credential is exercised in v1.
- Cloud / cluster-base / CLI scaffolder changes — none needed; the `/git-token` endpoint and the worker proxy already exist (#766, #768, #819).
