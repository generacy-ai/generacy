# Tasks: Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop

**Input**: Design documents from `/specs/762-summary-when-cluster-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = observability, US2 = proactive refresh, US3 = 401 classification)

---

## Phase 1: Setup & Verification

- [X] T001 Verify `gh` CLI stderr format for 401 (open item from research.md D3): run `GH_TOKEN=fake gh repo view <any-private-or-public-repo>` locally and record the exact stderr substring(s) (`HTTP 401: Bad credentials`, `(HTTP 401)`, etc.) into a short note in `specs/762-summary-when-cluster-s/research.md` D3 "Reference" subsection so the regex fixture in T010 covers reality.

---

## Phase 2: Foundation — Shared Types & Schemas

- [X] T002 Create `packages/orchestrator/src/types/github-auth.ts` containing:
  - `GitHubAuthStatus` type (`'ok' | 'failing' | 'unknown'`)
  - `GitHubAuthSnapshot` interface (per data-model.md §`GitHubAuthSnapshot`)
  - `PerCredentialState` internal interface
  - `CredentialDescriptor` interface
  - `CredentialsEventPayload` discriminated union (`refresh-requested` / `auth-failed` / `auth-recovered`)
  - Zod schemas matching `contracts/cluster-credentials-event.schema.json` and `contracts/github-auth-health.schema.json` (parse-time validation in tests; runtime emit is type-checked only)
- [X] T003 [P] Add `GhAuthError` class to `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (exported alongside the existing client) per data-model.md §`GhAuthError`. Do not yet throw it; T010 wires the throw site.

---

## Phase 3: User Story 3 — Monitors Distinguish 401 from Transient Errors (P1, blocks US1)

**Goal**: `LabelMonitorService` and `PrFeedbackMonitorService` route HTTP 401 errors through a typed exception so US1 can observe them as a distinct event.

**Independent test**: With a fake `gh` CLI that prints `HTTP 401: Bad credentials` on stderr, calling `pollRepo()` throws/catches `GhAuthError` (instead of generic poll error) and emits one distinct warn log line.

### Implementation for US3

- [X] T010 [US3] Implement `parseGhStatusCode(stderr: string): number | undefined` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` matching `/HTTP\s+(\d{3})/i`. In `executeGh()` (or the existing stderr-handling chokepoint near `gh-cli.ts:47-50`), throw `new GhAuthError(401, stderr, …)` when `parseGhStatusCode(stderr) === 401`. Keep all other error paths unchanged so non-401 callers see today's behavior.
- [X] T011 [US3] Modify `packages/orchestrator/src/services/label-monitor-service.ts:489` (`pollRepo()` catch branch): catch `GhAuthError` distinctly **before** the generic catch. On the auth branch, log one structured `warn` line (`{ credentialId, statusCode: 401 } "GitHub authentication failing — investigate credential refresh chain"`) and notify the health service (wired in T021 — for now expose a callback/dependency on `GitHubAuthHealthService` injected via constructor, default no-op). Re-raise/return so the existing retry loop continues unchanged.
- [X] T012 [US3] Mirror T011 in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` `pollRepo()` (same catch ordering, same structured log, same callback hook).

### Tests for US3

- [X] T013 [P] [US3] Add `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.401-parsing.test.ts` (or co-located equivalent next to `gh-cli.ts`):
  - fixtures: `HTTP 401: Bad credentials`, `gh: ... (HTTP 401)`, multi-line stderr with the line not first, empty stderr, non-401 (`HTTP 500`)
  - asserts `parseGhStatusCode` return values
  - asserts `executeGh` throws `GhAuthError` only when stderr indicates 401
- [X] T014 [P] [US3] Add `packages/orchestrator/tests/unit/services/label-monitor-service.401.test.ts`:
  - stub `GhCliGitHubClient` to throw `GhAuthError(401, ...)`
  - assert exactly one structured warn log (`statusCode: 401`)
  - assert the injected health-service callback is invoked with `{ ok: false, statusCode: 401 }`
  - assert no generic `"Error polling repository"` log on the 401 path
- [X] T015 [P] [US3] Add `packages/orchestrator/tests/unit/services/pr-feedback-monitor-service.401.test.ts` mirroring T014 for the PR feedback monitor.

**Checkpoint**: US3 is independently deliverable — the 401 path is observable in logs even without US1/US2. Tests pass in isolation.

---

## Phase 4: User Story 1 — Operator-Visible GitHub Auth State (P1, depends on US3 callbacks)

**Goal**: `/health` exposes a `githubAuth` field; transitions emit `auth-failed` / `auth-recovered` events on `cluster.credentials`; monitor 401 callbacks drive state.

**Independent test**: Synthesize calls to `health.recordResult(credId, {ok:false,statusCode:401})` and verify (a) `snapshot()` returns `{ status: 'failing', consecutiveFailures: 1, … }`, (b) one `auth-failed` event was emitted, (c) the next `recordResult(credId, {ok:true})` emits exactly one `auth-recovered` and snapshot flips to `ok`.

### Implementation for US1

- [X] T020 [US1] Create `packages/orchestrator/src/services/github-auth-health.ts` implementing `GitHubAuthHealthService` per data-model.md §`GitHubAuthHealthService` contract:
  - constructor options `{ emitEvent, logger, now?, minRefreshIntervalMs? }`
  - internal `Map<credentialId, PerCredentialState>`
  - `setCredentials(descriptors)` — idempotent add/remove
  - `recordResult(credentialId, result)` — implements the state-machine transitions in data-model.md §`GitHubAuthStatus` (emit on transitions only; 401 path may call `maybeRequestRefresh(id, 'auth-401')`)
  - `maybeRequestRefresh(credentialId, reason)` — 60s per-credential rate limit, structured `warn` log on emit and `debug` log on suppress
  - `snapshot()` — single-credential selection rule (failing > ok > unknown, lexicographic tiebreak), maps internal epoch-ms to ISO strings
- [X] T021 [US1] Wire `GitHubAuthHealthService` instance into `packages/orchestrator/src/server.ts`:
  - construct it after the relay client ref is available, with `emitEvent: payload => relayClientRef?.send({ type:'event', event:'cluster.credentials', data: payload, timestamp: new Date().toISOString() })` (silent drop when ref is null, matching D2 in research.md)
  - pass the service to `LabelMonitorService` and `PrFeedbackMonitorService` constructors so the T011/T012 callbacks become real `health.recordResult(...)` calls (replace the default no-op)
  - export an accessor so `/health` route can call `snapshot()`
- [X] T022 [US1] Modify `packages/orchestrator/src/routes/health.ts`:
  - read `GitHubAuthHealthService.snapshot()` and include it as `githubAuth` on the response body
  - update both the 200 and 503 response Fastify schemas to declare `githubAuth` with only `status` and `consecutiveFailures` required (per research.md D7); other sub-fields optional
- [X] T023 [US1] Resolve `credentialId` for monitor callsites (per research.md D5): at orchestrator startup, parse `<agencyDir>/credentials.yaml` once, derive the first `type: 'github-app'` credential ID, and inject it (via constructor or DI option) into the monitor services so each `health.recordResult(...)` call has a real id. If no github-app credential exists, monitors call no-op variant and health stays `unknown` (FR backwards-compatibility default).

### Tests for US1

- [X] T024 [P] [US1] Add `packages/orchestrator/tests/unit/services/github-auth-health.test.ts`:
  - state-machine matrix from data-model.md §`GitHubAuthStatus`: `unknown→ok`, `unknown→failing`, `ok→failing`, `failing→ok` (with `auth-recovered`), `failing→failing` (no emit, counter increments)
  - `recordResult({ok:false, statusCode:500})` does not transition
  - `setCredentials([])` clears entries (no leftover `failing`)
  - `snapshot()` selection rule with multiple credentials (failing wins, then ok, then unknown; lexicographic tiebreak)
  - rate-limit: 3 calls in 30s emit one `refresh-requested`; 4th call after 61s emits another
  - inject `now()` for deterministic time

**Checkpoint**: US1 is independently deliverable on top of US3. `/health` is observable; events are wired; recovery semantics work even without the proactive timer.

---

## Phase 5: User Story 2 — Proactive Expiry Detector (P1, depends on US1 state owner)

**Goal**: A 60s timer reads `expiresAt` from `.agency/credentials.yaml` and asks `GitHubAuthHealthService` to request a refresh when <5 min remain.

**Independent test**: With a synthetic `credentials.yaml` whose `expiresAt` is 4 min from a fake `now()`, one tick of `CredentialExpiryWatcher` calls `health.maybeRequestRefresh(id, 'near-expiry')` exactly once and emits one `refresh-requested` event.

### Implementation for US2

- [X] T030 [US2] Create `packages/orchestrator/src/services/credential-expiry-watcher.ts` implementing `CredentialExpiryWatcher` per data-model.md §`CredentialExpiryWatcher`:
  - constructor `{ agencyDir, health, logger, tickIntervalMs=60_000, nearExpiryWindowMs=5*60_000, now? }`
  - `start()` sets `setInterval`; `stop()` clears and awaits any in-flight tick
  - each tick: `stat()` `<agencyDir>/credentials.yaml`; on `ENOENT` no-op; on mtime change `YAML.parse` and call `health.setCredentials([...])`; iterate and call `health.maybeRequestRefresh(id, 'near-expiry')` for any credential where `(expiresAtMs - now) <= nearExpiryWindowMs`
  - all errors caught and logged at `warn`; never throws out of the timer (D9)
  - share YAML reader pattern with `packages/control-plane/src/services/wizard-env-writer.ts:78-96` (don't duplicate Zod schemas — import from T002 types)
- [X] T031 [US2] Wire `CredentialExpiryWatcher` into `packages/orchestrator/src/server.ts`:
  - construct after `GitHubAuthHealthService` (T021), before `server.listen()` returns
  - resolve `agencyDir` from existing env/config the same way `wizard-creds-token-provider.ts` does
  - call `.start()` after relay client ref is wired
  - register `.stop()` in graceful-shutdown handler alongside other services

### Tests for US2

- [X] T032 [P] [US2] Add `packages/orchestrator/tests/unit/services/credential-expiry-watcher.test.ts`:
  - mock filesystem (in-memory or `memfs`) and `health` (spy on `setCredentials`, `maybeRequestRefresh`)
  - tick with no file: no calls; one warn log only on first miss
  - tick with file whose `expiresAt` is 4 min away: `maybeRequestRefresh(id, 'near-expiry')` called once
  - tick with file whose `expiresAt` is 10 min away: `maybeRequestRefresh` not called
  - mtime change between ticks: `setCredentials` called again with the new descriptors
  - parser error: logged at `warn`, timer survives (next tick still runs)

**Checkpoint**: US2 is independently deliverable on top of US1. Proactive refresh requests flow to the cloud; SC-001 and SC-004 measurable in isolation.

---

## Phase 6: Integration — End-to-End Wiring

- [X] T040 Smoke-test event shape against `contracts/cluster-credentials-event.schema.json`: in `tests/unit/services/github-auth-health.test.ts` (or a new contract test file), parse each emitted payload through the Zod schema (re-derived from the JSON Schema or hand-mirrored in T002). Fail the test if the discriminator, required fields, or types drift.
- [X] T041 Smoke-test `/health` response shape against `contracts/github-auth-health.schema.json`: in `tests/integration/health.test.ts` (or extend an existing health test), assert the response body satisfies the schema for at least three states (`unknown`, `ok`, `failing`).
- [X] T042 Verify the relay channel `'cluster.credentials'` is in the allowlist used by `setupInternalRelayEventsRoute` (per research.md D2 reference): check `packages/orchestrator/src/routes/internal-relay-events.ts` `ALLOWED_CHANNELS` (or equivalent) lists it. If missing, add. (Most likely already present — verify only.)

---

## Phase 7: Polish & Documentation

- [ ] T050 [P] Run `pnpm --filter @generacy-ai/orchestrator test` and `pnpm --filter @generacy-ai/workflow-engine test` — full suites green.
- [ ] T051 [P] Run `pnpm --filter @generacy-ai/orchestrator build` and `pnpm --filter @generacy-ai/workflow-engine build` — typecheck/build green.
- [ ] T052 [P] Manually run the quickstart Synthetic auth-failure validation (quickstart.md §"Synthetic auth-failure validation") against a local cluster: confirm SC-001 (<2 min to detect), SC-002 (default-level log distinguishable), SC-004 (≤1 refresh event per 60s).
- [ ] T053 [P] Update `CLAUDE.md` (top-level) with a short Cluster-Side GH_TOKEN Backstop entry (file paths + one-line behavior) following the existing style of "Control-Plane Daemon Crash Resilience (#624)" etc. Only add WHY/WHAT that won't be obvious from reading the code six months from now.
- [ ] T054 File the companion cloud ticket (per Q2 / research.md D2 reference): GitHub issue against `generacy-ai/generacy-cloud` for the `action: 'refresh-requested'` consumer (so SC-003 end-to-end auto-recovery has a tracked counterpart). Link both directions.

---

## Dependencies & Execution Order

**Sequential phases**:
1. Phase 1 (Setup) → Phase 2 (Foundation) → Phase 3 (US3) → Phase 4 (US1) → Phase 5 (US2) → Phase 6 (Integration) → Phase 7 (Polish).

**Why the sequence**:
- T002 (types) is the import target of every service file → blocks Phase 3+.
- T010 (gh-cli.ts `GhAuthError` throw site) → blocks T011/T012 (monitor catch branches).
- T011/T012 monitor callsites → expose a callback hook used by T021 to wire the real health service.
- T020 (`GitHubAuthHealthService`) → required by T021 (server wiring), T022 (`/health` route), T030/T031 (expiry watcher).
- T030 (`CredentialExpiryWatcher`) consumes the health service surface from T020; can be developed against the type, but lands after US1 so the watcher's `maybeRequestRefresh` calls are real.

**Parallel opportunities within phases**:
- Phase 2: T002 must finish before T003, but T003 (`GhAuthError` class shell in a different package) can land in parallel with the start of T002 if both are split into separate PRs / commits.
- Phase 3 tests T013, T014, T015 are independent files → all `[P]`.
- Phase 4: T024 is a single new test file → `[P]` with all Phase 3 polish.
- Phase 5: T032 is a single new test file → `[P]`.
- Phase 7: T050, T051, T052, T053 are independent → all `[P]`. T054 is also `[P]` (external action, doesn't block code).

**Independent story slices**:
- **US3 alone** ships an observable 401 in logs (no `githubAuth` field, no events, no proactive timer) — useful for incident triage even partially landed.
- **US3 + US1** ships the full observability story (logs + `/health` + events) without the proactive expiry timer.
- **US3 + US1 + US2** ships the full feature.

This means the natural commit order is: T001 → T002 → T003 → T010 → T011 → T012 → tests (T013–T015) → T020 → T021 → T022 → T023 → T024 → T030 → T031 → T032 → T040–T042 → polish.
