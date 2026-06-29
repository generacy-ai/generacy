# Tasks: Cockpit — Orchestrator API Status Tier (Queue Depth / Workers)

**Input**: Design documents from `/specs/792-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete
**Mode**: Epic (coarse-grained task groups)

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Task group can run in parallel with other `[P]` groups in the same phase
- **[Story]**: Which user story this task group addresses

## Phase 1: Foundation — Client + Shared Helpers

<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

Foundational changes the command-layer task groups depend on. Both groups in this phase are independent of one another (different files, different packages) and can be done in parallel.

### TG-001 [P] [US1, US2, US3] Cockpit `OrchestratorClient` — `getWorkers()` returns `{ count }`

**Scope**: ~3 hours. Latent always-`0` bug fix + type-surface cleanup.
**Files**:
- `packages/cockpit/src/orchestrator/client.ts` (MODIFIED)
- `packages/cockpit/src/index.ts` (MODIFIED — re-export surface)
- `packages/cockpit/src/__tests__/orchestrator-client.test.ts` (MODIFIED)
**Tests**: `orchestrator-client.test.ts` — assert `{ count }` shape for `/dispatch/queue/workers`; drop all `WorkerSummary[]` assertions; keep error/network/timeout coverage; add a case proving the always-`0` bug is gone (server returns `{count: 7}` → client returns `{available: true, count: 7}`).

- [ ] Replace `WorkersResult` definition: union of `{available: false, reason, statusCode?}` and `{available: true, count: number}` per data-model §1.
- [ ] Rewrite `getWorkers()` live-client branch in `client.ts:144` to consume `body.count` directly via `httpClient.get('/dispatch/queue/workers')`; no `pickArrayField`, no `normalizeWorkers`.
- [ ] Remove `WorkerSummary` type and `normalizeWorkers` helper (no remaining consumers — verified in research R7).
- [ ] Update `packages/cockpit/src/index.ts` re-exports: drop `WorkerSummary`, keep `WorkersResult`, `OrchestratorClient`, `JobsResult` source-compatible.
- [ ] Confirm `stub.ts` already returns `{available: false, reason: 'no-token'}` for `getWorkers()` and needs no shape change.
- [ ] Update `orchestrator-client.test.ts`: replace `WorkerSummary[]`-shaped fixtures with `{count: N}` fixtures; assert non-2xx → `http-error`; assert network → `cloud-unreachable`; assert `body.count: 7` flows through to `result.count === 7`.

---

### TG-002 [P] [US2] CLI shared helpers — token precedence + first-failure warner

**Scope**: ~2 hours. Two small pure functions + unit tests. No I/O.
**Files**:
- `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-token.ts` (NEW)
- `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-warn.ts` (NEW)
- `packages/generacy/src/cli/commands/cockpit/__tests__/orchestrator-token.test.ts` (NEW)
- `packages/generacy/src/cli/commands/cockpit/__tests__/orchestrator-warn.test.ts` (NEW)
**Tests**: pure-function unit tests for both helpers — no process/env touching beyond passing `envValue`/`configValue` as arguments; no real stderr write (inject a `WarnSink` capture).

- [ ] Implement `resolveOrchestratorToken({envValue, configValue}): string | undefined` per data-model §2: trim both, empty/whitespace ⇒ undefined, env-trimmed-non-empty wins, else config-trimmed-non-empty, else undefined.
- [ ] Implement `createFirstFailureWarner(sink: WarnSink): FirstFailureWarner` per data-model §3: first call writes `"cockpit: orchestrator unavailable: <reason>\n"` and sets `fired = true`; subsequent calls return without writing; expose `hasFired()` for tests.
- [ ] Cover token-precedence matrix in unit test: env-only, config-only, both (env wins), neither (undefined), env-whitespace-falls-back-to-config, both-whitespace-undefined.
- [ ] Cover warner in unit test: first call writes once and `hasFired()` flips; second call is silent and the captured sink only saw one write; reason string interpolated literally.

## Phase 2: Command Wiring

<!-- Phase boundary: Complete Phase 1 before starting Phase 2. TG-003 and TG-004 may run in parallel within Phase 2 — they touch disjoint files. -->

Both task groups consume Phase 1 (`WorkersResult.count`, token helper, warner). They edit disjoint files in the CLI package and have no shared mutation points, so they can be executed in parallel.

### TG-003 [P] [US1, US2] `status` command — token wiring, footer label, first-failure warner

**Scope**: ~4 hours. Wire env-var token discovery, swap footer label to `"M active workers"`, plumb first-failure warner through `getFooter`, keep `--json` envelope byte-stable.
**Files**:
- `packages/generacy/src/cli/commands/cockpit/status.ts` (MODIFIED)
- `packages/generacy/src/cli/commands/cockpit/shared/orchestrator-footer.ts` (MODIFIED)
- `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` (MODIFIED — small label carry-through)
- `packages/generacy/src/cli/commands/cockpit/__tests__/status.footer.test.ts` (MODIFIED)
- `packages/generacy/src/cli/commands/cockpit/__tests__/status.token-precedence.test.ts` (NEW)
**Tests**: footer-text assertions for all 3 states (available / no-token / unavailable) covering SC-001..003 + SC-006; token-precedence CLI-edge test (env > config > none) using injected `process.env` snapshot; assert first-failure stderr emits exactly once per invocation; assert `renderJsonEnvelope` parses and `orchestrator.available` is present in all 3 states.

- [ ] Replace the existing token-read at `status.ts:75-77` with a call to `resolveOrchestratorToken({envValue: process.env.ORCHESTRATOR_API_TOKEN, configValue: loaded.config.orchestrator?.token})`.
- [ ] Construct `createFirstFailureWarner(process.stderr.write.bind(process.stderr))` per CLI invocation; thread into `getFooter(client, 1500, warner)`.
- [ ] In `shared/orchestrator-footer.ts`: consume `workersResult.count` (was `.workers.length` per old shape); update `renderFooter` available branch to literal `orchestrator: ${jobs} jobs, ${workers} active workers` (contract A); update `getFooter` to call `onFirstFailure` once when either call returns unavailable (skip on `no-token`).
- [ ] Confirm `renderJsonEnvelope` already maps `FooterData` correctly; assert `workers` field name stays `workers` (NOT `activeWorkers`) for #787 back-compat.
- [ ] Update `status.footer.test.ts`: new literal `"M active workers"`; add the first-failure-only stderr assertion; keep no-token / unavailable / timeout footer text fixtures.
- [ ] New `status.token-precedence.test.ts`: env-set + config-set ⇒ env value passed to factory; env-unset + config-set ⇒ config value passed; both unset ⇒ stub factory (no HTTP); whitespace env ⇒ falls through to config.

---

### TG-004 [P] [US3] `watch` command — `orchestrator-counts` NDJSON event + emit-on-transition

**Scope**: ~5 hours. New event type, new zod schema, new state-machine helper, watch loop integration.
**Files**:
- `packages/generacy/src/cli/commands/cockpit/watch.ts` (MODIFIED)
- `packages/generacy/src/cli/commands/cockpit/watch/orchestrator-counts.ts` (NEW — `pollOrchestratorCounts` + `OrchestratorCountsEventSchema`)
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.orchestrator-counts.test.ts` (NEW)
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.orchestrator-failure.test.ts` (NEW)
**Tests**: baseline emit always fires on first tick (even when unavailable); no emit on equal `{jobs,workers}` ticks; emit on jobs-change, workers-change, available↔unavailable transitions, and unavailable-with-different-reason; GH poll loop continues unaffected when orchestrator is unreachable (SC-005); exit code 0 on SIGTERM; first-failure stderr fires once across many failing ticks.

- [ ] Create `watch/orchestrator-counts.ts` exporting `OrchestratorCountsState`, `OrchestratorCountsEvent`, `OrchestratorCountsEventSchema` (zod discriminated union per contract C), and `pollOrchestratorCounts(client, prev, warner, timeoutMs=1500)` returning `{event, curr}` per data-model §5 state table.
- [ ] Reuse the existing `getFooter`-style `Promise.race` timeout (1500 ms default) — do NOT introduce a new timeout helper; per-call race only so a hung orchestrator never blocks the GH tick.
- [ ] In `watch.ts`: resolve token via `resolveOrchestratorToken(...)` (same helper as status); construct shared `FirstFailureWarner` once at startup; construct `OrchestratorClient` once; maintain `prevOrchestrator: OrchestratorCountsState | null` alongside the existing `prev: SnapshotMap`.
- [ ] On every tick, run `pollOrchestratorCounts` in parallel with the existing GH poll; when `event !== null`, write it as a single `process.stdout.write(JSON.stringify(event) + '\n')` after zod-validation.
- [ ] Confirm `CockpitEventSchema` is NOT mutated — `OrchestratorCountsEventSchema` is a sibling schema (contract C / research R4).
- [ ] `watch.orchestrator-counts.test.ts`: drive 5-tick fake-clock loop through every row of the state-machine table; assert NDJSON byte-stable.
- [ ] `watch.orchestrator-failure.test.ts`: orchestrator stub returns `cloud-unreachable` on all ticks; assert 1 baseline NDJSON + 0 follow-up emits; assert N GH events still flow; assert stderr saw exactly one warning line; assert clean SIGTERM exit 0.

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 (Phase 2 task groups consume the `{count}` shape from TG-001 and both helpers from TG-002)

**Parallel opportunities within phases**:
- TG-001 (cockpit package) and TG-002 (CLI shared helpers) touch disjoint packages and can run concurrently.
- TG-003 (status command) and TG-004 (watch command) touch disjoint files in the CLI package and can run concurrently after Phase 1.

**Cross-phase dependencies** (file-level):
- TG-003 imports the new `WorkersResult.count` from TG-001 via `shared/orchestrator-footer.ts`.
- TG-003 and TG-004 both import `resolveOrchestratorToken` and `createFirstFailureWarner` from TG-002.
- No task group modifies files owned by another group — phase-2 parallelism is safe.

**Success-criteria mapping**:
- SC-001 / SC-002 / SC-003 → TG-003 (status footer in 3 states)
- SC-004 → TG-003 (existing `getFooter` race; assert reason `timeout` and elapsed ≤ 1600 ms)
- SC-005 → TG-004 (`watch.orchestrator-failure.test.ts`)
- SC-006 → TG-003 (JSON envelope parse + `orchestrator.available` assertion)
