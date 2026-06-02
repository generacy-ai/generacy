# Tasks: Orchestrator Auto-Activation via Pre-Approved Device Code

**Input**: Design documents from `/specs/739-summary-managed-cloud-cluster/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: All tasks belong to the single bugfix user story `[US1]` — managed/cloud cluster deploys auto-activate without human interaction.

## Phase 1: Core Implementation — Orchestrator activation branch

- [X] T001 [US1] Add pre-approved device-code branch to `activate()` in `packages/orchestrator/src/activation/index.ts`. After the existing-key short-circuit (lines 47–59) and before the `for (cycle…)` loop:
  - Read `process.env['GENERACY_PRE_APPROVED_DEVICE_CODE']`.
  - When set, emit `logger.info({ event: 'activation-start', mode: 'pre-approved' })` (FR-008).
  - Call `pollForApproval({ cloudUrl, deviceCode, interval: 5, expiresIn: 60, httpClient, logger, workers: initialWorkers })` (reuses transient retry from `packages/activation-client/src/poller.ts`).
  - On `pollResult.status === 'approved'`: call `writeKeyFile(keyFilePath, …)`, `writeClusterJson(clusterJsonPath, …)`, then `delete process.env['GENERACY_PRE_APPROVED_DEVICE_CODE']` (FR-003), and return the `ActivationResult` mirroring `pollResult.*` fields.
  - On `pollResult.status === 'tier-limit-exceeded'`: `throw new ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')` (mirrors lines 90–99).
  - On terminal failure (`expired` / `already_redeemed` / invalid): emit `logger.warn('Pre-approved device code redemption failed (terminal); falling back to interactive flow')` and fall through to the existing `for (cycle…)` loop.
  - Add `logger.info({ event: 'activation-start', mode: 'interactive' })` immediately before the `for (cycle…)` loop (so both branches emit the structured `activation-start` line).
  - Never log the device-code value itself.

## Phase 2: Core Implementation — CLI scaffolder threading

- [X] T002 [P] [US1] Extend `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` (~lines 48–66): add `preApprovedDeviceCode: z.string().min(1).optional()` to the Zod object.

- [X] T003 [P] [US1] Extend `ScaffoldEnvInput` interface and `scaffoldEnvFile` body in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`:
  - Add `preApprovedDeviceCode?: string` to `ScaffoldEnvInput` (~line 39).
  - In `scaffoldEnvFile` body (~line 297), append after the `# Bootstrap mode` block:
    ```typescript
    ...(input.preApprovedDeviceCode
      ? [
          '',
          '# Cloud-supplied pre-approved RFC 8628 device code (single-use, short TTL).',
          '# Consumed by orchestrator activate() on first boot; never logged.',
          `GENERACY_PRE_APPROVED_DEVICE_CODE=${input.preApprovedDeviceCode}`,
        ]
      : []),
    ```
  - Treat empty string as absent (truthiness check, not `!== undefined`).

- [X] T004 [US1] Forward `preApprovedDeviceCode` through `packages/generacy/src/cli/commands/launch/scaffolder.ts` (~lines 93–106): in the `scaffoldEnvFile(...)` call, add `preApprovedDeviceCode: config.preApprovedDeviceCode`. Depends on T002 and T003.

- [X] T005 [US1] Forward `preApprovedDeviceCode` through `packages/generacy/src/cli/commands/deploy/scaffolder.ts` (~lines 59–69): in the `scaffoldEnvFile(...)` call, add `preApprovedDeviceCode: config.preApprovedDeviceCode`. Depends on T003 (and on T002 if `deploy` uses `LaunchConfig`).

## Phase 3: Tests

- [X] T006 [P] [US1] Add orchestrator activation unit tests in `packages/orchestrator/tests/unit/activation/index.test.ts` mirroring existing patterns. Add `beforeEach` that `delete process.env['GENERACY_PRE_APPROVED_DEVICE_CODE']` to avoid cross-test bleed. Cover:
  - **Pre-approved happy path**: env var set, `pollForApproval` mock returns `approved`. Assert `requestDeviceCode` is NOT called; `writeKeyFile` + `writeClusterJson` called with poll-result values; `process.env.GENERACY_PRE_APPROVED_DEVICE_CODE` is `undefined` after `activate()` resolves; returned `ActivationResult` matches; `logger.info` called with `{ event: 'activation-start', mode: 'pre-approved' }`.
  - **Pre-approved terminal failure → interactive fallback**: env var set, `pollForApproval` returns `{ status: 'expired' }`. Assert `requestDeviceCode` IS then called; `logger.warn` records the fallback; `logger.info` called with `{ event: 'activation-start', mode: 'interactive' }`.
  - **Pre-approved transient retry**: env var set, `pollForApproval` mock internally handles `authorization_pending` / `slow_down` and then returns `approved`. Assert single `pollForApproval` call succeeds and `requestDeviceCode` is NOT triggered (transient retries live inside `pollForApproval`, not `activate()`).
  - **No pre-approved → unchanged interactive path**: env var unset; existing interactive-flow test still passes; `logger.info` called with `{ event: 'activation-start', mode: 'interactive' }`.

- [X] T007 [P] [US1] Add CLI scaffolder tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`:
  - **Env line emitted when set**: `scaffoldEnvFile({ ..., preApprovedDeviceCode: 'ABCD-1234' })` writes the `GENERACY_PRE_APPROVED_DEVICE_CODE=ABCD-1234` line (and the two preceding comment lines).
  - **Env line absent when unset**: `scaffoldEnvFile({ ... })` without the field writes no `PRE_APPROVED` line.
  - **Empty string treated as absent**: `scaffoldEnvFile({ ..., preApprovedDeviceCode: '' })` writes no `PRE_APPROVED` line.

## Phase 4: Verification

- [X] T008 [US1] Run the quickstart scenarios in `specs/739-summary-managed-cloud-cluster/quickstart.md`:
  - Build affected packages: `pnpm --filter @generacy-ai/orchestrator build && pnpm --filter @generacy-ai/generacy build`.
  - Run unit tests: `pnpm --filter @generacy-ai/orchestrator test tests/unit/activation/index.test.ts` and `pnpm --filter @generacy-ai/generacy test src/cli/commands/cluster/__tests__/scaffolder.test.ts`.
  - Manually walk Scenarios 1–4 (pre-approved happy path, terminal-failure fallback, no-pre-approved interactive, restart-with-keyfile) and confirm the documented stdout JSON lines appear and the negative assertions hold (no `Cluster Activation Required` block on the happy path; device-code value never appears in logs).
  - Confirm acceptance criteria: managed deploy activates without human interaction; interactive flow still works when no pre-approved code is supplied; the API key is not written into cloud-init `user_data` (verified by reading `.env` — only the device code is present).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 is independent — it touches only `packages/orchestrator/src/activation/index.ts`.
- T004 depends on T002 (LaunchConfigSchema field) and T003 (ScaffoldEnvInput field).
- T005 depends on T003 (ScaffoldEnvInput field).
- T008 (verification) depends on T001–T007.

**Parallel opportunities**:
- **Batch A (parallel)**: T001, T002, T003 — all touch different files, no dependencies.
- **Batch B (after A)**: T004 and T005 in parallel — both forward to the now-extended scaffolder, but they edit different files.
- **Batch C (parallel with B)**: T006 and T007 in parallel — different test files; T006 can begin once T001 is in place, T007 once T003 is in place.
- **Batch D (last)**: T008 verification once all source + tests land.

**Suggested order**: T001 ∥ T002 ∥ T003 → T004 ∥ T005 ∥ T006 ∥ T007 → T008.

## Files Touched

| Task | File |
|------|------|
| T001 | `packages/orchestrator/src/activation/index.ts` |
| T002 | `packages/generacy/src/cli/commands/launch/types.ts` |
| T003 | `packages/generacy/src/cli/commands/cluster/scaffolder.ts` |
| T004 | `packages/generacy/src/cli/commands/launch/scaffolder.ts` |
| T005 | `packages/generacy/src/cli/commands/deploy/scaffolder.ts` |
| T006 | `packages/orchestrator/tests/unit/activation/index.test.ts` |
| T007 | `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` |
| T008 | (verification — runs against built artifacts) |

---

*Generated by `/speckit:tasks` at 2026-06-02*
