# Implementation Plan: Engage adaptive polling for clusters with no configured webhook

**Feature**: Fix `updateAdaptivePolling()` early-return dead branch across three monitor services by extracting a shared helper and threading a `webhooksConfigured` signal from construction.
**Branch**: `953-summary-updateadaptivepolling`
**Status**: Complete

## Summary

`updateAdaptivePolling()` is copy-pasted across `LabelMonitorService`, `PrFeedbackMonitorService`, and `MergeConflictMonitorService`. All three carry the same early return: `if (this.state.lastWebhookEvent === null) return;`. The safety net therefore only compensates for clusters that once had a working webhook and lost it — never for clusters that structurally lack an ingress. Per Q4=C, all three copies migrate to a shared helper. Per Q1=A and Q5=A, a construction-time `webhooksConfigured: boolean` on `MonitorState` distinguishes "configured but quiet" from "never configured". Per Q6=A (corrected), the derivation rule differs per service:

| Service | `webhooksConfigured` rule | Fast interval at defaults |
|---|---|---|
| `LabelMonitorService` | `config.smee.channelUrl != null` | `30_000 / 3` clamped to `10_000` = 10s |
| `PrFeedbackMonitorService` | hardcoded `false` (no reliable feeder signal) | `60_000 / 2` = 30s **only** when `adaptivePolling: true` |
| `MergeConflictMonitorService` | hardcoded `false` (no feeder at all) | `60_000 / 2` = 30s **only** when `adaptivePolling: true` |

To avoid silently doubling GitHub API load on every existing cluster, `PrMonitorConfigSchema.adaptivePolling` default flips from `true` to `false`. Operators opt in via `PR_MONITOR_ADAPTIVE_POLLING=true`.

For `LabelMonitorService`, when `webhooksConfigured === false` **and** `adaptivePolling === true`, the fast interval engages on cycle 1 (no grace, Q2=A). When `adaptivePolling === false`, the service stays at `basePollIntervalMs` — matching operator opt-out semantics (Q3=A). This makes `adaptivePolling` reachable in two distinct states, satisfying FR-005.

## Technical Context

- **Language**: TypeScript (ESM, Node >=22)
- **Package**: `packages/orchestrator/`
- **Framework**: None specific — plain classes, Fastify at server boundary
- **Dependencies**: `zod` (config schema), `pino` (logger). No new deps.
- **Test runner**: Vitest (existing convention in orchestrator)
- **Baseline knobs preserved**: `ADAPTIVE_DIVISOR` (per-service: 3 for LabelMonitor, 2 for the twins), `MIN_POLL_INTERVAL_MS = 10_000` (all three)

## Project Structure

```
packages/orchestrator/
  src/
    services/
      adaptive-poll-controller.ts        NEW — shared helper (Q4=C)
      label-monitor-service.ts           MOD  — delegate updateAdaptivePolling
      pr-feedback-monitor-service.ts     MOD  — delegate updateAdaptivePolling
      merge-conflict-monitor-service.ts  MOD  — delegate updateAdaptivePolling
    types/
      monitor.ts                         MOD  — add webhooksConfigured to MonitorState
    config/
      schema.ts                          MOD  — flip PrMonitorConfigSchema.adaptivePolling default → false
    server.ts                            MOD  — pass webhooksConfigured to all three constructors
    __tests__/
      adaptive-poll-controller.test.ts   NEW — helper regression: FR-002 / FR-005 / FR-007
      label-monitor-adaptive.test.ts     MOD/NEW — thin per-service test
      pr-feedback-adaptive.test.ts       MOD/NEW — thin per-service test
      merge-conflict-adaptive.test.ts    MOD/NEW — thin per-service test

specs/953-summary-updateadaptivepolling/
  spec.md                                (untouched — read-only)
  clarifications.md                      (unchanged)
  plan.md                                NEW (this file)
  research.md                            NEW
  data-model.md                          NEW
  contracts/
    adaptive-poll-controller.md          NEW — helper interface contract
  quickstart.md                          NEW

.changeset/
  953-adaptive-polling.md                NEW — patch bump (bugfix, no public API)
```

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo. Skipped.

Existing project conventions honoured:
- Changeset **required** for `packages/*/src/` diffs (per `CLAUDE.md`). Config-schema default flip is a behavioral change on an existing knob → `patch`. Public API unchanged.
- No comments added for what code already says. `Why:` comments only where the constraint isn't obvious from the surface.
- `adaptivePolling: false` on the twins is now a real fact-of-the-cluster on defaults; this must be captured in the changeset one-liner ("`prMonitor.adaptivePolling` now defaults `false` — opt in via `PR_MONITOR_ADAPTIVE_POLLING=true`") so operators see it at release time.

## Design Overview

### Shared helper (`adaptive-poll-controller.ts`)

Pure, stateless-ish helper taking the mutable slice of `MonitorState` it needs, plus the divisor + min interval as parameters. No `this`, no I/O — decision logic in one place, three callers pass their own tuning:

```ts
export interface AdaptivePollParams {
  webhooksConfigured: boolean;
  adaptivePolling: boolean;
  basePollIntervalMs: number;
  adaptiveDivisor: number;
  minPollIntervalMs: number;
}

export interface AdaptivePollDecision {
  currentPollIntervalMs: number;
  webhookHealthy: boolean;
  transition: 'to-fast' | 'to-base' | 'none';
  reason: 'webhooks-not-configured' | 'webhook-stale' | 'webhook-recovered' | 'operator-opt-out' | 'quiet';
}
```

Called from both `recordWebhookEvent()` and `updateAdaptivePolling()` on each service. Decision function returns everything the caller needs to (a) mutate `state` and (b) log — the caller owns state assignment and log emission so the log messages stay per-service (different strings today: "Webhooks appear unhealthy, increasing poll frequency" vs "…increasing PR feedback poll frequency" vs "…increasing merge-conflict poll frequency"). The helper only decides.

### State-model change

`MonitorState.webhooksConfigured: boolean` added, wired at construction from a new constructor arg. `webhookHealthy` retains its existing meaning: "the configured webhook path is currently delivering." When `webhooksConfigured === false` and `adaptivePolling === true`, `webhookHealthy` initializes to `false` conceptually — but the helper makes this an emitted `transition: 'to-fast'` on cycle 1, so the initial log line fires exactly once.

### `server.ts` wiring

Three constructor calls each grow a `webhooksConfigured` positional arg:

- `LabelMonitorService`: `config.smee.channelUrl != null`
- `PrFeedbackMonitorService`: `false` (literal, with a `// #953: no reliable feeder signal available at construction` comment)
- `MergeConflictMonitorService`: `false` (literal, with `// #953: recordWebhookEvent() has no callers anywhere`)

### Config schema

`PrMonitorConfigSchema.adaptivePolling.default(true)` → `.default(false)`. `MonitorConfigSchema.adaptivePolling.default(true)` unchanged — LabelMonitor still adaptively polls by default. On smee-configured LabelMonitor, `server.ts:469-471` already force-overrides to `adaptivePolling: false`; behavior on that path is unchanged.

## Behavior Matrix (FR-005 verification)

| Service | `webhooksConfigured` | `adaptivePolling` | Steady interval | Note |
|---|---|---|---|---|
| LabelMonitor | true (smee configured) | forced `false` at `server.ts:470` | `fallbackPollIntervalMs` (5m default) | unchanged |
| LabelMonitor | false | `true` (default) | `basePoll / 3` clamped to 10s → **10s at defaults** | fast from cycle 1 |
| LabelMonitor | false | `false` (opt-out) | `basePollIntervalMs` (30s default) | Q3=A, respects operator |
| PrFeedback | false (hardcoded) | `false` (new default) | `basePollIntervalMs` (60s default) | preserves current cadence |
| PrFeedback | false (hardcoded) | `true` (opt-in) | `basePoll / 2` clamped to 10s → 30s | fast from cycle 1 |
| MergeConflict | false (hardcoded) | `false` (new default via shared `prMonitor` config) | `basePollIntervalMs` (60s default) | preserves current cadence |
| MergeConflict | false (hardcoded) | `true` (opt-in) | `basePoll / 2` clamped to 10s → 30s | fast from cycle 1 |

`adaptivePolling` is now reachable in every meaningful column on every service — FR-005 satisfied without arm-twisting.

## Risks and Mitigations

1. **Silent doubling of GitHub API load** — avoided by flipping `PrMonitorConfigSchema.adaptivePolling` default to `false`. Called out in changeset.
2. **Test values collide with the clamp at defaults** — clarifications Q1 note: at 30s base + divisor 3, `basePoll / DIVISOR = 10s = MIN_POLL_INTERVAL_MS`. Test cases MUST use a base where divide and clamp diverge (e.g., 60s base + divisor 3 → 20s pre-clamp).
3. **Log-line semantics change** — LabelMonitor's smee-less path now emits a `to-fast` transition on cycle 1 instead of the current "no data, healthy" silence. Existing tests that assert on the current log line will need updating; grep scope is small (fewer than 10 files per initial survey).
4. **Migration risk to twins** — `PrFeedback` and `MergeConflict` haven't been running adaptive polling in practice (dead branch). New default `adaptivePolling: false` preserves their observed cadence exactly; operators who explicitly set `PR_MONITOR_ADAPTIVE_POLLING=true` get a documented cadence change.

## Testing Strategy

Regression test lives against the helper (FR-007). Each caller gets a thin test that asserts the correct divisor + `webhooksConfigured` value flows through and that logs fire on transitions:

- Helper unit tests: matrix of (webhooksConfigured, adaptivePolling, timeSinceLastWebhook) → decision. Includes clamp-vs-divide separation.
- LabelMonitor: `webhooksConfigured=false, adaptivePolling=true` → after `updateAdaptivePolling()` on cycle 1, `state.currentPollIntervalMs === basePollIntervalMs / 3` (clamped). One `info` log line emitted.
- LabelMonitor: `webhooksConfigured=false, adaptivePolling=false` → interval remains at `basePollIntervalMs` indefinitely.
- LabelMonitor: `webhooksConfigured=true, lastWebhookEvent=null` → no-op (preserves the "configured but quiet" grace).
- PrFeedback / MergeConflict: same shape, divisor 2, default `adaptivePolling=false` → interval stays at 60s.
- PrFeedback / MergeConflict: `adaptivePolling=true` → interval drops to `basePoll / 2` on cycle 1.

No integration tests planned — the change is scoped to internal state + per-cycle interval math.

## Next Steps

- `/speckit:tasks` to generate task list from this plan.
