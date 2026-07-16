# Feature Specification: ## Summary

When no smee channel is configured, the orchestrator degrades to polling and says nothing about it

**Branch**: `954-summary-when-no-smee` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

## Summary

When no smee channel is configured, the orchestrator degrades to polling and says nothing about it. Every smee-related log line lives inside the `if (config.smee.channelUrl)` branch, so the webhook-less case produces **no output at all** — silence is indistinguishable from "smee wasn't mentioned in the logs I grepped".

## How this presented

A fresh cluster (`snappoll`) was slow to react to labels on issues. The natural diagnostic — check the orchestrator logs for smee — returns nothing:

```
$ docker logs snappoll-orchestrator-1 2>&1 | grep -ci smee
0
```

Zero lines. Not a warning, not an error. Reaching the actual cause required reading `server.ts`, tracing the `config.smee.channelUrl` guard, inspecting the container's env, then diffing provisioning paths across three repos. A single startup warning would have collapsed that into one `grep`.

## The code

The only smee log statement in the startup path is inside the guard it would need to be outside of:

```ts
// packages/orchestrator/src/server.ts:487
if (config.smee.channelUrl) {
  ...
  server.log.info({ channelUrl: config.smee.channelUrl }, 'Smee webhook receiver configured');
}
```

Same shape at `server.ts:824` for `webhookSetupService.ensureWebhooks()` — skipped silently when the URL is empty, so no GitHub webhook is created either, also without comment.

Meanwhile the label monitor cheerfully logs `Starting label monitor polling` with `intervalMs: 30000`, which reads like healthy startup. Nothing signals that this is a **fallback** rather than the intended configuration.

## Proposed behaviour

Add an `else` branch that warns once at startup when running webhook-less. It should state the consequence, not just the condition — something along the lines of:

> No smee channel configured — falling back to polling. Label events will be detected in up to ~90s (poll interval 30000ms × COMPLETED_CHECK_INTERVAL 3) instead of near-instantly. Set `SMEE_CHANNEL_URL` or `orchestrator.smeeChannelUrl` in `.generacy/config.yaml`.

Worth including:

- The **latency the operator will actually experience** — the `completed:*` path is the slow one (`label-monitor-service.ts:83`, `COMPLETED_CHECK_INTERVAL = 3`), and it's what makes clusters feel stuck.
- The fact that **no GitHub webhook will be created** for the monitored repos.
- How to fix it.

Consider surfacing it on the health/status endpoint too, so it's visible without log archaeology.

## Note on log level

`warn` rather than `info`. This is a degraded operating mode with a real behavioural cost, not a routine configuration choice. It should stand out from the surrounding startup chatter.

## Related

- #952 — Orchestrator should auto-provision a smee channel when none is configured. Even once that lands, this warning stays relevant: provisioning can fail (offline, smee.io down) and fall back to polling, and that fallback must be loud rather than silent — otherwise the same debugging session repeats.
- #953 — Adaptive polling never engages for clusters that never had a webhook.

## Clarifications

Resolved in [`clarifications.md`](./clarifications.md) — Batch 1 (2026-07-16). Decisions that constrain the plan:

- **Q1 → A**: Ship the log-warning half **and** a `smeeConfigured: boolean` on `HealthResponse` (200 + 503 Fastify schemas in `packages/orchestrator/src/routes/health.ts`), plumbed from `config.smee.channelUrl` at `createServer()` construction. Do **not** ship a nested `smee: {...}` object — a boolean is the minimum consumer commitment; widening later is additive.
- **Q2 → B**: The warning states **both** label classes' worst-case latency, **computed from the effective `pollIntervalMs`** — not hardcoded to defaults. Format: `process:* up to ~<pollIntervalMs/1000>s`, `completed:* up to ~<pollIntervalMs*COMPLETED_CHECK_INTERVAL/1000>s`. Wrong numbers under non-default intervals is worse than silence.
- **Q3 → C**: The **warning fires full-mode only**, guarded **inside** the `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` block at `server.ts:464` on `!config.smee.channelUrl` (not as an `else` on the block — an `else` would falsely warn in worker mode, in pre-activation clusters with `repositories.length === 0`, and on deliberate `labelMonitor === false` opt-outs). The `/health` `smeeConfigured` field reports the config value on **all** processes (workers included) — that's a configuration statement, not a degradation claim.
- **Q4 → B**: Cover **both** webhook-setup skip reasons, at different levels. Case (a) `smee.channelUrl` empty is already covered by the Q3 warning. Case (b) `webhookSetup.enabled === false` gets its own **`info`** line (deliberate opt-out, not degradation). Warning on the opt-out would erode the "warn = degraded" signal; silence on it reproduces this issue's failure mode.
- **Q5 → B**: Warning is a **short message + structured Pino fields**, not prose. Shape: `server.log.warn({ pollIntervalMs, completedCheckInterval, processLatencyMs, completedLatencyMs, remediation: ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl'] }, 'No smee channel configured; polling fallback active')`. Matches surrounding convention (`server.ts:496` etc.). SC-004 substring assertions still hold against the serialised JSON line.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
