# Tasks: Smee-less startup surfaces a warning + `/health` field

**Input**: Design documents from `/specs/954-summary-when-no-smee/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/log-warning.md, contracts/health-response.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Bugfix — single behaviour thread; no user-story ID split. Story markers omitted.

## Phase 1: Setup

- [X] T001 Expose `LabelMonitorService.COMPLETED_CHECK_INTERVAL` for cross-module read: change `private static readonly` to `public static readonly` at `packages/orchestrator/src/services/label-monitor-service.ts:83`. No behaviour change — the internal callsite at line 461 continues to work. Rationale: `server.ts` warn payload must read the constant, not hardcode `3` (research.md §2, contracts/log-warning.md field contract row `completedCheckInterval`).

## Phase 2: Schema + Types (additive, no consumer break)

- [X] T002 [P] Add `smeeConfigured: z.boolean().optional()` to `HealthResponseSchema` in `packages/orchestrator/src/types/api.ts` (currently at ~line 210, after `githubAuth`). Semantics: `true` iff `config.smee.channelUrl` is a non-empty URL at `createServer()` construction. See `data-model.md` §1 and `contracts/health-response.md` "Zod schema".

- [X] T003 [P] Add `smeeConfigured?: boolean` field to the `HealthCheckOptions` interface in `packages/orchestrator/src/routes/health.ts:11` (after the `githubAuth?: () => …` field). Snapshot value, not a getter — `config.smee.channelUrl` cannot change at runtime (data-model.md §2 "No getter/callback" rationale).

- [X] T004 Add `smeeConfigured: { type: 'boolean' }` to **both** the 200 and 503 Fastify response schemas in `packages/orchestrator/src/routes/health.ts` (currently ~lines 66..104), placed alongside `codeServerReady` / `controlPlaneReady`. **Do not** add to any `required[]`. Depends on T003 (same file).

## Phase 3: Population

- [X] T005 Populate `HealthResponse.smeeConfigured` in `setupHealthRoutes` in `packages/orchestrator/src/routes/health.ts`. Immediately after `controlPlaneReady` is added to `response` (~line 141), add a conditional-attach block:
  ```ts
  if (options.smeeConfigured !== undefined) {
    response.smeeConfigured = options.smeeConfigured;
  }
  ```
  Match the `githubAuth`/`cluster` conditional-attach pattern already in the file (contracts/health-response.md "Population"). Depends on T002, T003, T004.

- [X] T006 Wire `smeeConfigured` at both `server.ts` callsites in `packages/orchestrator/src/server.ts`:
  - Worker-mode branch (~line 669): inside `await setupHealthRoutes(server, { … })`, add `smeeConfigured: !!config.smee.channelUrl`.
  - Full-mode branch (~line 702): inside `healthCheckOptions: { … }` passed to `registerRoutes`, add `smeeConfigured: !!config.smee.channelUrl`.
  Use `!!config.smee.channelUrl` (not `!== undefined`) so an empty-string value matches the runtime check at `server.ts:487` (contracts/health-response.md "Wire-through"). Depends on T003.

## Phase 4: Observability — warn on polling fallback

- [X] T007 Add the `warn` `else` branch inside the label-monitor construction block at `packages/orchestrator/src/server.ts:487` (`if (config.smee.channelUrl) { … } else { … }`). Payload signature exactly per `contracts/log-warning.md`:
  ```ts
  server.log.warn(
    {
      pollIntervalMs: monitorConfig.pollIntervalMs,
      completedCheckInterval: LabelMonitorService.COMPLETED_CHECK_INTERVAL,
      processLatencyMs: monitorConfig.pollIntervalMs,
      completedLatencyMs: monitorConfig.pollIntervalMs * LabelMonitorService.COMPLETED_CHECK_INTERVAL,
      remediation: ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl'],
    },
    'No smee channel configured; polling fallback active',
  );
  ```
  Read `pollIntervalMs` from the already-computed `monitorConfig` local (server.ts:469..471), not from `config.monitor.pollIntervalMs` directly — that keeps the "effective" invariant when smee-fallback overrides are ever added. Depends on T001 (`COMPLETED_CHECK_INTERVAL` visibility).

## Phase 5: Observability — info on webhook-setup opt-out

- [X] T008 Add the `else if` `info` branch adjacent to the webhook-setup guard at `packages/orchestrator/src/server.ts:824`. Insert immediately after the existing `if (config.webhookSetup.enabled && config.smee.channelUrl) { … }` block:
  ```ts
  else if (config.smee.channelUrl && !config.webhookSetup.enabled) {
    server.log.info(
      { remediation: ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled'] },
      'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos',
    );
  }
  ```
  Only fires when smee IS set and setup IS disabled — the smee-unset case is already covered by T007. `info`, not `warn`: deliberate opt-out is not degradation (research.md §4). No dependency on T007 code-wise but sits in the same file; sequence after to keep the diff coherent.

## Phase 6: Tests

- [X] T009 [P] NEW `packages/orchestrator/src/__tests__/server-smee-fallback-warning.test.ts`. Cover (per research.md §5):
  1. `mode: 'full'`, `labelMonitor: true`, `repositories: [{owner, repo}]`, `smee.channelUrl: undefined` → exactly one `warn` fires with the message `No smee channel configured; polling fallback active` and field shape from `contracts/log-warning.md`. Substring assertions (SC-004): serialised line contains `smee`, `polling`, `SMEE_CHANNEL_URL`, `orchestrator.smeeChannelUrl`, `pollIntervalMs`, `completedCheckInterval`, `processLatencyMs`, `completedLatencyMs`.
  2. Numeric invariants: `record.completedLatencyMs === record.pollIntervalMs * record.completedCheckInterval` AND `record.completedCheckInterval === 3`.
  3. Non-default `pollIntervalMs: 60000` → `pollIntervalMs: 60000`, `processLatencyMs: 60000`, `completedLatencyMs: 180000` (the "computed, not hardcoded" test — contracts/log-warning.md).
  4. Negative: `smee.channelUrl: 'https://smee.io/abc'` → **zero** warns matching the diagnostic message.
  5. Negative: `mode: 'worker'` with `smee.channelUrl: undefined` → **zero** warns (Q3→C worker-mode false-warning matrix).
  6. Negative: `mode: 'full'`, `repositories: []` (pre-activation) → **zero** warns.
  7. Negative: `labelMonitor: false` → **zero** warns.
  Follow the existing `packages/orchestrator/src/__tests__/server-*.test.ts` startup-wiring test pattern. Prefer `server.log.warn` spy over Pino buffer-stream unless the existing pattern uses the latter.

- [X] T010 [P] NEW `packages/orchestrator/src/__tests__/server-smee-opt-out-info.test.ts`. Cover (per research.md §5):
  1. `smee.channelUrl: 'https://smee.io/abc'`, `webhookSetup.enabled: false` → exactly one `info` fires with message `Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos` and `remediation: ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled']`.
  2. Negative: `smee.channelUrl: 'https://smee.io/abc'`, `webhookSetup.enabled: true` → zero info logs matching that message.
  3. Negative: `smee.channelUrl: undefined`, `webhookSetup.enabled: false` → zero info logs matching that message (the §4 line does NOT fire when smee is unset — T007's warn covers it).

- [X] T011 [P] NEW `packages/orchestrator/src/routes/__tests__/health-smee-field.test.ts`. Cover (per contracts/health-response.md "Test invariants" SC-002):
  1. Boot server with `smee.channelUrl: undefined` → `GET /health` body has `smeeConfigured: false`. Fastify response-schema validation passes (proves 200 schema updated).
  2. Second boot with `smee.channelUrl: 'https://smee.io/abc'` → `smeeConfigured: true`.
  3. Simulate 503-path (degraded services) with `smee.channelUrl: 'https://smee.io/abc'` → response still validates and includes `smeeConfigured: true` (proves 503 schema updated).
  4. Worker-mode: `smee.channelUrl: undefined`, `mode: 'worker'` → response body has `smeeConfigured: false` (Q3→C "configuration statement, not degradation claim").
  5. Harness-omission: call `setupHealthRoutes(server, {})` directly with **no** `smeeConfigured` on options → response body has no `smeeConfigured` key (proves the conditional-attach guard from T005; test-harness contract from contracts/health-response.md "Guard rationale").
  Follow the existing `packages/orchestrator/src/routes/__tests__/health.test.ts` pattern.

## Phase 7: Changeset + polish

- [X] T012 Add `.changeset/954-smee-fallback-observability.md` at `patch` level bumping `@generacy-ai/orchestrator`. Rationale (plan.md Constitution Check): defect fix; `smeeConfigured` is optional/additive on the public `HealthResponse` schema — no consumer break. Copy the shape of a comparable existing `.changeset/*.md`. Required by the changeset CI gate (see CLAUDE.md "Changesets" — speckit implement phase must add its own).

- [X] T013 Run local verification per `quickstart.md`:
  - `pnpm --filter @generacy-ai/orchestrator test` — all new + existing tests green.
  - `pnpm --filter @generacy-ai/orchestrator build` — TypeScript passes (proves `HealthCheckOptions` field addition and `HealthResponse` inference wire through).
  - `pnpm --filter @generacy-ai/orchestrator lint` if configured.
  Depends on T009, T010, T011, T012.

## Dependencies & Execution Order

**Sequential edges** (must complete before dependents):

- T001 → T007 (warn payload reads `LabelMonitorService.COMPLETED_CHECK_INTERVAL`)
- T002 + T003 + T004 → T005 (population reads the option field and typed response shape)
- T003 → T006 (wire-through passes the option field defined in T003)
- T005 + T006 → T011 (health test asserts populated response body end-to-end)
- T007 → T009 (test asserts the warn shape)
- T008 → T010 (test asserts the info shape)
- T009 + T010 + T011 + T012 → T013 (final verification)

**Parallel opportunities**:

- **After T001**, T002/T003 can start immediately alongside T007's precondition being satisfied.
- **T002, T003 are `[P]`** — different files (`types/api.ts` vs `routes/health.ts`), no dependency between them.
- **T004 blocks on T003** only because it edits the same file (`routes/health.ts`); if handled in the same commit, order T003 → T004 sequentially.
- **T009, T010, T011 are all `[P]`** — three different NEW test files, no shared state. Their **code** dependencies (T007, T008, T005+T006) must land first, but the test files themselves can be authored in parallel.
- **T012 is `[P]`** with everything except T013 — it's a NEW `.changeset/*.md` file untouched by any other task.

**Suggested execution ribbon**:

1. T001 (unblocks warn payload).
2. Parallel: T002, T003 (schema + option field).
3. T004 (Fastify schemas, same file as T003).
4. Parallel: T005 (populate), T006 (wire-through), T007 (warn), T008 (info).
5. Parallel: T009, T010, T011 (three test files), T012 (changeset).
6. T013 (verify).

## Notes

- **No new dependencies.** No new files outside the three new tests and the changeset (plan.md "Technical Context").
- **No refactor scope.** `LabelMonitorService` gets one visibility change (T001), nothing else. `SmeeConfigSchema` / `WebhookSetupConfigSchema` untouched.
- **Warn vs info discipline** (research.md §4): T007 = `warn` (degradation), T008 = `info` (deliberate opt-out). Do not conflate — flipping either would erode the "warn = degraded" signal.
- **Full-mode-only warning** (Q3 → C): T007 sits **inside** the `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` block on the `else` of `if (config.smee.channelUrl)`. Do NOT hoist it outside the block or convert to an outer `else` — it would false-warn in worker mode, pre-activation clusters, and deliberate opt-outs.
- **Health field on all processes** (Q3 → C): T006 wires `smeeConfigured` from **both** worker-mode and full-mode branches. The field is a configuration statement (does this cluster have a smee URL), not a degradation claim (is this process polling).
