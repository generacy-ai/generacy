# Implementation Plan: Smee-less startup surfaces a warning + `/health` field

**Feature**: When no smee channel is configured, the orchestrator degrades to polling silently. Add a startup `warn` log inside the label-monitor construction block and a `smeeConfigured: boolean` field on `/health` (200 + 503 schemas). Cover the second webhook-setup skip reason (`webhookSetup.enabled === false`) with a paired `info` line.
**Branch**: `954-summary-when-no-smee`
**Status**: Complete

## Summary

Two silent skips today:

1. `packages/orchestrator/src/server.ts:487` — the receiver is constructed inside `if (config.smee.channelUrl)` with no `else`, so the fallback-to-polling case emits **zero** log lines. `docker logs … | grep -i smee` returns nothing on a polling-only cluster.
2. `packages/orchestrator/src/server.ts:824` — `if (config.webhookSetup.enabled && config.smee.channelUrl)` is silently false for **two** independent reasons (smee URL empty, or webhook-setup opt-out). Only one is covered by the fix above.

This spec ships:

- **Warning log**, gated inside the existing `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` block (server.ts:464) on `!config.smee.channelUrl`. Short message + structured Pino fields with both label-class latencies **computed from the effective `pollIntervalMs`** and `COMPLETED_CHECK_INTERVAL = 3` (from `label-monitor-service.ts:83`).
- **`/health` field** `smeeConfigured: boolean`, plumbed from `config.smee.channelUrl` at `createServer()` construction (server.ts:669 worker-branch, :702 full-branch → `healthCheckOptions`). Present on **all** processes (workers included) — it is a configuration statement, not a degradation claim.
- **`info` line** on the second webhook-setup skip reason (`webhookSetup.enabled === false`), so an operator inheriting an opt-out config gets one observable line rather than silence.

## Technical Context

- **Language**: TypeScript (Node >=22, ESM).
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`).
- **Framework**: Fastify (route registration + Pino logger via `server.log`).
- **Config**: `OrchestratorConfigSchema` (`packages/orchestrator/src/config/schema.ts`). `SmeeConfigSchema.channelUrl` is `z.string().url().optional()` — the fallback path is the field being `undefined`, not an empty string. `WebhookSetupConfigSchema.enabled` defaults to `false`.
- **Health types**: `HealthResponseSchema` (`packages/orchestrator/src/types/api.ts:210`). Field additions are additive — existing consumers unaffected.
- **Tests**: Vitest. Existing patterns: `packages/orchestrator/src/routes/__tests__/health.test.ts` (health-route shape), `packages/orchestrator/src/__tests__/server-*.test.ts` (server startup wiring).
- **No new deps.** No new files outside tests.

## Project Structure

```
packages/orchestrator/
  src/
    server.ts                      # MODIFIED — add warn + info branches, thread smeeConfigured
    config/
      schema.ts                    # UNCHANGED (Smee/Webhook schemas already model both branches)
    routes/
      health.ts                    # MODIFIED — HealthCheckOptions.smeeConfigured; add to 200/503 schemas + response
      index.ts                     # UNCHANGED (passthrough to setupHealthRoutes)
    types/
      api.ts                       # MODIFIED — HealthResponseSchema gains smeeConfigured: boolean().optional()
    services/
      label-monitor-service.ts     # UNCHANGED — export COMPLETED_CHECK_INTERVAL if it isn't already
    __tests__/
      server-smee-fallback-warning.test.ts    # NEW — asserts warn shape when channelUrl empty (SC-001, SC-004)
      server-smee-opt-out-info.test.ts        # NEW — asserts info shape when webhookSetup.enabled=false
    routes/__tests__/
      health-smee-field.test.ts               # NEW — smeeConfigured in /health response (SC-002)

specs/954-summary-when-no-smee/
  plan.md                          # this file
  research.md                      # decisions + rationale
  data-model.md                    # types touched (HealthResponse, HealthCheckOptions, log-payload shape)
  contracts/
    log-warning.md                 # exact Pino payload contract (Q5→B) + substring assertions (SC-004)
    health-response.md             # HealthResponse JSON shape + Fastify 200/503 schema deltas
  quickstart.md                    # how to reproduce, verify, and toggle both branches
```

## Constitution Check

No `.specify/memory/constitution.md` in this repo. The general constraints that apply:

- **No cross-feature refactors.** This spec touches `server.ts`, `routes/health.ts`, `types/api.ts` and adds tests. It does **not** modify `SmeeConfigSchema`, `WebhookSetupConfigSchema`, `LabelMonitorService`, or existing tests.
- **Changesets.** The diff touches `packages/orchestrator/src/` non-test files → the implement phase must add a new `.changeset/954-*.md` at `patch` level (defect fix; no public API surface change beyond the additive optional field).
- **Additive schema change.** `smeeConfigured` is `optional()` on `HealthResponseSchema` and marked as a plain `boolean` in the Fastify 200/503 schemas without adding it to `required` — no consumer break.
- **Warn semantics preserved.** Only actual degradation warns; the deliberate opt-out logs at `info`. Rationale in FR-005 + clarifications Q4→B.
- **No worker-mode false warnings.** Log lives inside the full-mode block guarded on `!config.smee.channelUrl` (clarifications Q3→C).

## Key decisions (link to research.md)

- **Where the warning lives** — inside the label-monitor construction block, not as an `else` on it. Falsely warning in worker mode / pre-activation / opt-out modes is worse than fixing the original silence. See research.md §1.
- **What the warning says** — short message + structured Pino fields (Q5→B). Both `process:*` and `completed:*` worst-case latencies are stated, computed from `pollIntervalMs` and `COMPLETED_CHECK_INTERVAL`. See research.md §2 and contracts/log-warning.md.
- **What `/health` exposes** — one boolean `smeeConfigured` (Q1→A). Not a nested `smee: {...}` object. Widening later is additive. See research.md §3 and contracts/health-response.md.
- **Second skip reason** — `webhookSetup.enabled === false` gets an `info` line at server.ts:824's inverse branch (Q4→B). See research.md §4.

## Suggested next step

`/speckit:tasks` — generate the task list.
