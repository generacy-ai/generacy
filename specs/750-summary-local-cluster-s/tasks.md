# Tasks: Local Cluster Identity Split Detection

**Input**: Design documents from `/specs/750-summary-local-cluster-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cluster-identity-split-event.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = single identity / verification gate; US2 = mismatch detection + relay event)

## Phase 1: Setup

- [X] T001 [P] [US2] Add `'cluster.identity-split'` to the `ALLOWED_CHANNELS` tuple in `packages/orchestrator/src/routes/internal-relay-events.ts` (documents the channel even though emission is in-process; keeps the allowlist authoritative for future cross-process emitters).

## Phase 2: Core Implementation

- [X] T002 [US2] Create `packages/orchestrator/src/services/identity-split-detector.ts` with:
  - `IdentitySplitEvent` interface — `{ env_cluster_id, cluster_json_cluster_id, detected_at }` (snake_case, matches data-model.md §Output).
  - `DetectionOutcome` discriminated union — `no-env | no-cluster-json | match | mismatch` (per data-model.md §DetectionOutcome).
  - `DetectIdentitySplitOptions` interface — `{ clusterJsonPath, env?, sendRelayEvent?, logger }`.
  - Module-level `let hasEmitted = false` once-guard.
  - `export async function detectIdentitySplit(options)`: reads `env.GENERACY_CLUSTER_ID`, calls `readClusterJson(clusterJsonPath)` (import from `../activation/persistence.ts`), branches on the four outcomes, and on `mismatch` calls `sendRelayEvent('cluster.identity-split', payload)` exactly once across the process lifetime. Swallow + log any `sendRelayEvent` throw (FR-005, contracts/cluster-identity-split-event.md §Failure handling).
  - `export function resetIdentitySplitDetectionState()` test helper (resets `hasEmitted` to `false`).
  - NEVER mutate `process.env`, `.env`, or `cluster.json` (FR-003).

- [X] T003 [US2] Wire `detectIdentitySplit` into the existing-key startup path in `packages/orchestrator/src/server.ts` (~line 357, after `initializeRelayBridge()` returns and `relayClientRef` is set). Pass `clusterJsonPath` (use the same `/var/lib/generacy/cluster.json` path constant used by `activate()`), `logger`, and a `sendRelayEvent` closure that calls `relayClientRef.send({ type: 'event', event: 'cluster.identity-split', data: payload, timestamp: new Date().toISOString() })` — mirror the wire envelope from `routes/internal-relay-events.ts` (#600 fix shape).

- [X] T004 [US2] Wire `detectIdentitySplit` into the background-activation (wizard-mode) startup path in `packages/orchestrator/src/server.ts` (~line 720, inside `activateInBackground` after `await relayBridge.start()` succeeds). Same call shape as T003. Both call sites converge on "relay bridge has started → run detector once" (research.md §D6).

## Phase 3: Tests

- [X] T005 [US2] Create `packages/orchestrator/src/__tests__/identity-split-detector.test.ts` covering each `DetectionOutcome` branch:
  - `match` → outcome `match`, no `sendRelayEvent` call.
  - `mismatch`, first call → outcome `mismatch` with `emitted: true`, exactly one `sendRelayEvent` call with payload shape per contracts/cluster-identity-split-event.md.
  - `mismatch`, second call after `resetIdentitySplitDetectionState()` NOT called → outcome `mismatch` with `emitted: false`, still only one total `sendRelayEvent` call (FR-005).
  - Missing env (`env.GENERACY_CLUSTER_ID` unset) → outcome `no-env`, no event.
  - Missing `cluster.json` (mock `readClusterJson` returning `null`) → outcome `no-cluster-json`, no event.
  - `sendRelayEvent` throws → swallowed; no exception propagates; logger.error called; `hasEmitted` still flipped (single attempt counts, per quickstart.md table).
  - Use `resetIdentitySplitDetectionState()` in `beforeEach` for test isolation.

- [X] T006 [P] [US1] In `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts`, add (or confirm) an assertion that `scaffoldEnvFile` writes the input `config.clusterId` byte-for-byte to the `GENERACY_CLUSTER_ID` line of the generated `.env` (FR-001 verification gate). No new behavior — this test locks in the current correct behavior at `packages/generacy/src/cli/commands/launch/scaffolder.ts:71-114` so a future regression to client-side UUID minting fails fast.

## Phase 4: Follow-up

- [ ] T007 [P] [US1] File the cloud companion issue in `generacy-ai/generacy-cloud` per FR-006 and quickstart.md §"Cloud companion issue":
  - **Title**: "Device-code activation must reuse claim's clusterId instead of minting a fresh UUID"
  - **Body**: cross-reference this issue (#750), cite root cause at `services/api/src/services/cluster-activation.ts:385-386`, link #744, generacy-cloud#792 / #796 / #801.
  - Track as related issue; do NOT block this issue's merge on it.

## Dependencies & Execution Order

**Sequential dependencies**:
- T002 must complete before T003 and T004 (server.ts wires the detector — needs it to exist).
- T002 must complete before T005 (tests import the detector).
- T003 and T004 can be done in the same edit pass (same file, `server.ts`) but are listed separately because they touch distinct call sites with distinct conditions.

**Parallel opportunities**:
- T001 [P] is independent (channel allowlist string addition — touches only `internal-relay-events.ts`).
- T006 [P] is independent (touches only the launch scaffolder test file, different package).
- T007 [P] is administrative (file an external issue — no code).
- After T002 lands, T005 can run in parallel with the T003/T004 wiring edits (different files).

**Suggested order**:
1. T001 + T006 + T007 in parallel (independent setup / verification gate / follow-up filing).
2. T002 (core detector module).
3. T003 + T004 (server.ts wiring, same file — do in one edit pass).
4. T005 (detector unit tests).

## Notes

- Two user stories map cleanly: **US1 = T006 + T007** (single-identity verification gate + cloud companion that delivers prevention); **US2 = T001 + T002 + T003 + T004 + T005** (detection + relay event).
- No new dependencies, no new packages.
- No state mutation anywhere (FR-003 is the load-bearing invariant — every task must respect it).
- Detector emits at most once per process (FR-005). Module-level `hasEmitted` flag enforces this; T005 covers it.
