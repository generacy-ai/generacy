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


## User Stories

### US1: Operator diagnosing a slow cluster finds the fallback in one grep

**As a** cluster operator watching a fresh cluster react slowly to issue-label events,
**I want** the orchestrator to log a loud, one-shot warning at startup when no smee channel is configured,
**So that** `docker logs <orch> 2>&1 | grep -i smee` immediately explains the latency — instead of forcing me to read `server.ts`, trace the `config.smee.channelUrl` guard, inspect container env, and diff provisioning paths across repos.

**Acceptance Criteria**:
- [ ] On startup with `config.smee.channelUrl` empty/unset, the orchestrator emits exactly one `warn`-level log line naming smee.
- [ ] The warning states the *consequence* (fallback to polling; label events detected in up to ~90s given `pollIntervalMs=30000` × `COMPLETED_CHECK_INTERVAL=3`), not just the condition.
- [ ] The warning states that **no GitHub webhook will be created** for monitored repos (mirrors the silently-skipped `webhookSetupService.ensureWebhooks()` at `server.ts:824`).
- [ ] The warning includes remediation: set `SMEE_CHANNEL_URL` env or `orchestrator.smeeChannelUrl` in `.generacy/config.yaml`.
- [ ] The configured-happy-path log (`server.ts:487` — `Smee webhook receiver configured`) is unchanged.

### US2: Health/status endpoint reflects webhook-less mode

**As a** cluster operator (or a cockpit UI querying the cluster),
**I want** the `/health` (or equivalent status) response to indicate that the cluster is in polling-only mode,
**So that** operational tooling can surface the degraded mode without log archaeology.

**Acceptance Criteria**:
- [ ] `/health` (or the same surface that reports `controlPlaneReady` / `codeServerReady`) reports a boolean or string field indicating whether smee is configured.
- [ ] Field is stable enough for the cockpit / cloud dashboard to consume.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | When `config.smee.channelUrl` is empty at startup, emit exactly one `warn`-level log line stating the orchestrator is falling back to polling. | P1 | Add an `else` to the `if (config.smee.channelUrl)` block at `packages/orchestrator/src/server.ts:487`. |
| FR-002 | The warning MUST include the observed detection latency for `completed:*` labels expressed from the effective `pollIntervalMs` and `COMPLETED_CHECK_INTERVAL=3` (`label-monitor-service.ts:83`). | P1 | Latency string should reference concrete numbers so operators recognise "why is my cluster stuck for ~90s" instantly. |
| FR-003 | The warning MUST state that no GitHub webhook will be created for monitored repos. | P1 | Mirrors `webhookSetupService.ensureWebhooks()` being skipped at `server.ts:824`. |
| FR-004 | The warning MUST include remediation pointing at both `SMEE_CHANNEL_URL` env and `orchestrator.smeeChannelUrl` in `.generacy/config.yaml`. | P1 | Both names should appear verbatim so `grep` finds them. |
| FR-005 | Log level MUST be `warn`, not `info`. | P1 | Per issue "Note on log level": this is a degraded operating mode, must stand out from startup chatter. |
| FR-006 | The warning MUST fire exactly once per orchestrator process lifetime — not per repo, not per poll cycle. | P2 | One-shot startup line only. |
| FR-007 | When `config.smee.channelUrl` is set, orchestrator behaviour and log output MUST be unchanged (no new warning, existing `info` log preserved). | P1 | Non-regression guardrail. |
| FR-008 | `/health` (or equivalent status surface) SHOULD expose a `smeeConfigured: boolean` (or equivalent) field so cockpit/dashboard can render the degraded mode without scraping logs. | P2 | "Consider surfacing it on the health/status endpoint too" — treat as SHOULD unless clarified otherwise. |
| FR-009 | The `WebhookSetupService` skip-path at `server.ts:824` MUST also be observable — either covered by the same one-shot warning (preferred) or by its own warn line. | P2 | Silent skip of webhook creation is the second half of the same bug. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time-to-diagnose a webhook-less cluster from operator perspective. | ≤ 1 shell command (`docker logs <orch> 2>&1 \| grep -i smee`) returns a self-explanatory line. | Reproduce issue scenario on a fresh cluster with no `SMEE_CHANNEL_URL` — grep must return ≥ 1 line with `warn` level and the word `polling`. |
| SC-002 | Grep-ability of the warning. | `grep -ci smee` returns ≥ 1 on a webhook-less startup. | Same repro as SC-001. |
| SC-003 | Non-regression on configured path. | 0 new warn/error lines at startup when `SMEE_CHANNEL_URL` is set. | Diff orchestrator startup logs before/after the change with URL configured. |
| SC-004 | Warning content completeness. | The warn line mentions `polling`, an explicit latency number (or the formula), `webhook`, and both remediation names (`SMEE_CHANNEL_URL`, `orchestrator.smeeChannelUrl`). | Assert substring presence in unit/integration test on the emitted log. |
| SC-005 | Health endpoint observability (if FR-008 implemented). | `/health` returns a `smeeConfigured` field matching the runtime configuration. | Curl `/health` in both configured and webhook-less startups. |

## Assumptions

- The fix targets `packages/orchestrator/src/server.ts` — the two guarded blocks at lines 487 (receiver construction + `info` log) and 824 (webhook setup service).
- `config.smee.channelUrl` is the single source of truth for whether smee is configured; empty string and undefined are both treated as "not configured".
- Related work in #952 (auto-provision smee channel) does **not** obviate this warning — provisioning can fail (offline, smee.io down) and fall back to polling; that fallback still needs to be loud per the issue.
- Related work in #953 (adaptive polling never engages without prior webhook) is out of scope here — this feature only makes the fallback visible.
- The effective poll cadence used in the warning message should reflect any `fallbackPollIntervalMs` override (`server.ts:470`) if that path is taken, but at minimum should reference the currently effective `pollIntervalMs`.

## Out of Scope

- Auto-provisioning a smee channel when none is configured (tracked as #952).
- Adaptive polling engagement for never-webhook clusters (tracked as #953).
- Changing the polling cadence or `COMPLETED_CHECK_INTERVAL` itself.
- Changing behaviour when the smee channel *is* configured but unreachable at runtime — this issue is about the never-configured case.
- Reworking cockpit/dashboard UI to render the new health field — surfacing the field is in scope; consuming it downstream is not.

---

*Generated by speckit*
