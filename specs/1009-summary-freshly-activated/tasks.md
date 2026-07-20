# Tasks: Gate VS Code tunnel on post-activation restart settling

**Input**: Design documents from `/specs/1009-summary-freshly-activated/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = the only story in this bugfix)

## Phase 1: Setup — schema/type deltas

Additive, optional-field changes. Each file is independent, so all three are parallel.

- [ ] T001 [P] [US1] Add optional `postActivationReady: z.boolean().optional()` to `HealthResponseSchema` in `packages/orchestrator/src/types/api.ts` (parallel-construct with the existing `codeServerReady` / `controlPlaneReady` entries; see `contracts/health-response.md`).
- [ ] T002 [P] [US1] Add optional `postActivationReady?: boolean` to `ClusterMetadataPayload` in `packages/orchestrator/src/types/relay.ts` (parallel-construct with `codeServerReady` / `controlPlaneReady`; see `contracts/cluster-metadata.md`).
- [ ] T003 [P] [US1] Add optional `postActivationReady?: boolean` to the `ClusterMetadata` interface in `packages/cluster-relay/src/messages.ts` (same pattern as its `codeServerReady?: boolean`).

## Phase 2: Core — probes, monitor, control-plane predicate

Three new modules, three independent files. All parallel.

- [ ] T004 [P] [US1] Create `packages/orchestrator/src/services/post-activation-settled-probe.ts`. Export `isPostActivationSettledSync(paths?: { keyFilePath?: string; markerPath?: string }): boolean`. Defaults: key = `/var/lib/generacy/cluster-api-key`, marker = `/var/lib/generacy/post-activation-restart-done`. Semantics: `!existsSync(keyFilePath) || existsSync(markerPath)`. Sync only, no side effects, no caching. Truth table per `data-model.md` §Derived value.
- [ ] T005 [P] [US1] Create `packages/orchestrator/src/services/post-activation-settled-monitor.ts`. Export class `PostActivationSettledMonitor` with `start()` / `stop()` and constructor `{ onSettled: () => void; markerPath?: string; logger?: Logger }`. On `start()`: if predicate already true → no-op; else install `fs.watch(dirname(markerPath))` filtered by basename; on event whose target basename matches and marker now `existsSync` → invoke `onSettled` once, close watcher. Idempotent `.start()` / `.stop()`. Safe on missing dir (log at warn + no-op). No timers, no polling.
- [ ] T006 [P] [US1] Create `packages/control-plane/src/services/post-activation-settled.ts`. Export `isPostActivationSettledSync(paths?)` with the same predicate as T004. Standalone (not shared package) — control-plane doesn't need the `activated` fallback to differ, but keep the `!existsSync(keyFilePath) || existsSync(markerPath)` shape identical so the two sides can never diverge in interpretation.

## Phase 3: Unit tests for probe and monitor

Tests target files created in Phase 2. Each test file is independent.

- [ ] T007 [P] [US1] Add `packages/orchestrator/src/__tests__/post-activation-settled-probe.test.ts` covering the full truth table from `data-model.md`:
  - `!keyFile && !marker` → true (local cluster).
  - `!keyFile && marker` → true.
  - `keyFile && !marker` → false (wizard pre-restart — gate active).
  - `keyFile && marker` → true (wizard post-restart).
  Use `mkdtempSync` + custom paths, matching existing pattern in `post-activation-retry.test.ts`.
- [ ] T008 [P] [US1] Add `packages/orchestrator/src/__tests__/post-activation-settled-monitor.test.ts` covering:
  - Marker present at `start()` → no watcher installed, `onSettled` never called.
  - Marker absent at `start()`, then file appears → `onSettled` fires exactly once, watcher closes; subsequent writes to the marker do not re-fire.
  - `start()` then `stop()` before marker appears → no callback, watcher cleaned up (no leaked handle).
  - Recheck-existsSync guard: rename/mv events that leave the marker absent do not fire `onSettled`.

## Phase 4: Wiring — health, relay-bridge, server boot, cluster-relay metadata

Sequential inside each file; independent across files.

- [ ] T009 [US1] Modify `packages/orchestrator/src/routes/health.ts`:
  - Add `postActivationReady: { type: 'boolean' }` to both the 200 and 503 Fastify response schemas (mirror `codeServerReady` / `controlPlaneReady` at ~L87-88 / ~L105-106).
  - In the `GET /health` handler (~L116), after the existing `Promise.all([probeCodeServerSocket(), probeControlPlaneSocket()])`, call `const postActivationReady = isPostActivationSettledSync();` and include it in the response object.
  - Import `isPostActivationSettledSync` from the new `services/post-activation-settled-probe.ts` (T004).
- [ ] T010 [US1] Modify `packages/orchestrator/src/services/relay-bridge.ts`:
  - In `collectMetadata()` (~L706-720), set `metadata.postActivationReady = isPostActivationSettledSync();` alongside the existing socket probes.
  - No change to trigger cadence in this file — the extra push comes from the monitor wired in T011.
- [ ] T011 [US1] Modify `packages/orchestrator/src/server.ts`:
  - After `relayBridge` construction in BOTH the "existing API key" branch and the wizard/background-activation branch, instantiate `PostActivationSettledMonitor` with `onSettled: () => { void relayBridge.sendMetadata(); }` and `.start()` it.
  - Register `.stop()` in the graceful shutdown path.
  - When settled at boot the monitor is a no-op (no watcher installed) — this covers local clusters and wizard clusters that reboot after the restart has already happened. No new state on the server object beyond the monitor ref.
- [ ] T012 [US1] Modify `packages/cluster-relay/src/metadata.ts`:
  - Extend `HealthData` interface with `postActivationReady?: boolean`.
  - In `fetchHealth`, read `data['postActivationReady'] === true` and set on the returned health data (mirror `codeServerReady`).
  - In `collectMetadata`, copy `postActivationReady` onto the returned `ClusterMetadata` (mirror `codeServerReady`).

## Phase 5: Control-plane lifecycle gating

Sequential (single file), depends on T006.

- [ ] T013 [US1] Modify `packages/control-plane/src/routes/lifecycle.ts`:
  - Import `isPostActivationSettledSync` from the new `services/post-activation-settled.ts` (T006).
  - **`bootstrap-complete` branch (~L168)**: after steps (a) `writeWizardEnvFile()`, (b) sentinel write, (c) `codeServerManager.start()` have fired, wrap step (d) `tunnelManager.start()` in `if (isPostActivationSettledSync()) { … } else { logger.info({ postActivationReady: false }, 'Skipped tunnelManager.start() in bootstrap-complete: cluster pre-restart') }`. Response body unchanged (still `{ accepted: true, action: 'bootstrap-complete', sentinel }`).
  - **`vscode-tunnel-start` branch (~L77)**: BEFORE calling `tunnelManager.start()`, add `if (!isPostActivationSettledSync()) { logger.info(..., 'Skipped vscode-tunnel-start: cluster pre-restart (postActivationReady=false)'); return 200 with { accepted: false, action: 'vscode-tunnel-start', deferred: false, reason: 'post-activation-not-settled', message: 'Cluster is still starting up; retry once postActivationReady is true' }; }`. No watcher, no device-code initiation, no relay event. Shape per `contracts/lifecycle-skip-response.md`.
  - Steps (a) and (b) MUST NOT be gated — they are what causes the marker to eventually exist (see spec FR-004 / Q6/D).

## Phase 6: Lifecycle handler tests

- [ ] T014 [US1] Add / extend lifecycle handler tests under `packages/control-plane/src/__tests__/` (extend existing lifecycle test file if present, else create). Cover:
  - `vscode-tunnel-start` when settled → forwards to `tunnelManager.start()` as today.
  - `vscode-tunnel-start` when not settled → returns 200 with `{ accepted: false, action: 'vscode-tunnel-start', deferred: false, reason: 'post-activation-not-settled', message: ... }`; `tunnelManager.start()` NOT invoked; no watcher installed; no `cluster.vscode-tunnel` event emitted.
  - `bootstrap-complete` when settled + `hasGitHubToken` → step (d) fires as today; response `{ accepted: true, action, sentinel }`.
  - `bootstrap-complete` when NOT settled + `hasGitHubToken` → steps (a) `writeWizardEnvFile`, (b) sentinel write, (c) `codeServerManager.start()` all fire; (d) `tunnelManager.start()` NOT invoked; response body unchanged.
  - `bootstrap-complete` when `!hasGitHubToken` → existing awaiting-credentials path unchanged (regression guard).

## Phase 7: Regression / SC-004 guard

- [ ] T015 [P] [US1] Add explicit local-cluster regression test (SC-004): synthetic env where `keyFilePath` does NOT exist → `isPostActivationSettledSync()` returns `true` at boot; `PostActivationSettledMonitor` installs no watcher; `bootstrap-complete` handler executes step (d) unchanged. Prevents accidental permanent gating of local `generacy launch` clusters. May live inside the existing probe or lifecycle test files, whichever is more natural — the point is that a single test explicitly asserts this scenario end-to-end.

## Phase 8: Changeset (required — CI gate)

- [ ] T016 [US1] Add `.changeset/1009-post-activation-settled-gate.md` (newly-added file — the changeset-bot gate greps `--diff-filter=A`, editing an existing file will not satisfy it) with `minor` bumps for `@generacy-ai/orchestrator`, `@generacy-ai/control-plane`, and `@generacy-ai/cluster-relay` (new capability: a new boolean field on wire + new gate behavior). Copy the shape of a comparable existing `.changeset/*.md` in the repo.

## Phase 9: Verification

- [ ] T017 [US1] Follow `specs/1009-summary-freshly-activated/quickstart.md` end-to-end:
  1. Verify pre-fix repro on a fresh wizard cluster (`snappoll`-style): tunnel button appears during pre-restart window, device-code auth succeeds, `token.json` never persists.
  2. On the fixed build: `POST /lifecycle/vscode-tunnel-start` returns the skip response if invoked directly during the pre-restart window; post-restart `BootResumeService` dispatches `vscode-tunnel-start`; the retained `authorization_pending` event replays the device code to the modal; single authorization persists to `token.json` in the `vscode-cli-state` volume (SC-001, SC-003).
  3. Verify SC-002 push latency: instrument `sendMetadata()` invocation on marker-appearance; confirm ≤5s p95 from marker write to cloud-received timestamp on `cluster.metadata`.
  4. Verify SC-004: `generacy launch` local cluster reports `postActivationReady: true` immediately at boot; `bootstrap-complete` step (d) fires as before.

## Dependencies & Execution Order

**Strict phase ordering**: 1 → 2 → 3, then Phase 4 depends on Phase 2, Phase 5 depends on Phase 2 (T006), Phase 6 depends on Phase 5, Phase 7 depends on Phases 2+5, Phase 8 depends on all code phases (the changeset lands with the code diff it describes), Phase 9 depends on everything landed.

**Parallelizable within phase**:
- Phase 1: T001, T002, T003 (three independent type files).
- Phase 2: T004, T005, T006 (three new files, no cross-imports).
- Phase 3: T007, T008 (two independent test files).
- Phase 4: T009, T010, T012 can run in parallel; T011 depends on T010 (both modify orchestrator wiring but different files — T011 needs `relayBridge.sendMetadata` to exist, which is already present, so T011 is really only sequenced against the completion of T004/T005 for imports).
- Phase 7: T015 is independent of Phase 6 and can land alongside it.

**Critical path**: T004 (probe) → T009/T010 (health + collectMetadata use it) → T011 (server wires monitor). T006 (control-plane predicate) → T013 (lifecycle gates use it) → T014 (tests). T016 (changeset) must be a **newly-added** file in the PR diff, so add it as part of the final commit, not as an afterthought.

**Do NOT skip T016** — the changeset gate is the single most common reason a speckit PR lands red (see `CLAUDE.md` §Changesets).
