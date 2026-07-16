# Clarifications: Engage adaptive polling for clusters with no configured webhook

**Issue**: [#953](https://github.com/generacy-ai/generacy/issues/953)
**Branch**: `953-summary-updateadaptivepolling`

---

## Batch 1 — 2026-07-16

### Q1: FR-002 engagement mechanism
**Context**: FR-002 lists three concrete options for how adaptive polling should engage when webhooks are not configured, and does not commit to one. Each has meaningfully different downstream shape: the state fields on `LabelMonitorService`, the log fields FR-004 needs, and how the interval reaches the adaptive value on cycle 1 vs. after a threshold. The implementer needs a single answer before they can shape `updateAdaptivePolling()` and its state.
**Question**: Which mechanism should the fix use when `webhooksConfigured === false`?
**Options**:
- A: **Skip adaptive-polling entirely; run at the fast interval from the start.** Compute `basePollIntervalMs / ADAPTIVE_DIVISOR` (clamped to `MIN_POLL_INTERVAL_MS`) once at construction and use it as the steady-state interval. `updateAdaptivePolling()` becomes a no-op on this branch. No "adaptation" happens at runtime — the interval is fixed-fast.
- B: **Treat webhooks as unhealthy immediately.** At construction, seed `webhookHealthy = false` (or equivalent) so the existing "webhooks appear unhealthy" branch of `updateAdaptivePolling()` fires on the first poll cycle. Reuses the current transition path and log line semantics; may need a distinguishing field per FR-004.
- C: **Seed `lastWebhookEvent` at poll-loop start.** Set `lastWebhookEvent = poll-loop-start-time` in the smee-less branch so the existing elapsed-time comparison naturally trips after `basePollIntervalMs * 2`. Adaptive polling engages after a bounded grace, not immediately.

**Answer**: *Pending*

---

### Q2: Startup grace period
**Context**: FR-002 says "immediately (or via a bounded startup grace)." The choice affects SC-001 (target: ≤ `basePollIntervalMs / ADAPTIVE_DIVISOR` "after ≤ 1 cycle") — a non-zero grace shifts when the fast interval is first observed. Option C in Q1 inherently uses a `basePollIntervalMs * 2` grace; options A and B can be engaged immediately or with a grace. Independent from Q1 only if Q1 → A or B.
**Question**: If Q1 is A or B, is there any startup grace before the fast interval takes effect?
**Options**:
- A: **No grace — engage on cycle 1.** Fast interval is used from the first poll after construction. Simplest, matches SC-001's "≤ 1 cycle" target most directly.
- B: **Bounded grace equal to `basePollIntervalMs`** (one base cycle). Polls at base for one cycle, then flips to adaptive on cycle 2. Rationale: minimal accommodation for services that haven't finished initialization; still bounded and predictable.
- C: **N/A — Q1 answer is C** (existing `basePollIntervalMs * 2` threshold defines the grace by construction).

**Answer**: *Pending*

---

### Q3: `adaptivePolling: false` operator opt-out semantics
**Context**: FR-005 says the `adaptivePolling` flag "MUST have a reachable effect for at least one code path" with preference to "honor it (default `true`)." Today the flag is only ever read on the smee-less path (smee-configured path force-sets it to `false`). If an operator explicitly sets `adaptivePolling: false` on a smee-less cluster, the fix must define what interval they get — otherwise the flag remains ambiguous. Impacts config-schema validation and unit-test cases for FR-007.
**Question**: When `adaptivePolling === false` on a smee-less cluster (operator opt-out), which interval is used?
**Options**:
- A: **Stay at `basePollIntervalMs` indefinitely.** Operator opt-out preserves current stuck-at-base behavior on purpose — the flag is a knob for "I don't want the fast poll rate for API-cost or rate-limit reasons." Matches the natural reading of "opt out of adaptive polling."
- B: **Use `fallbackPollIntervalMs` (the smee-configured fallback).** Treat opt-out as "poll at the pre-configured fallback cadence, whatever that is." Consistent with the smee-configured branch.
- C: **Reject the config combination at load time.** `adaptivePolling: false` + no smee is a configuration error (the flag has no meaning without a real-time path). Fail loud in `config/loader.ts` with a clear message pointing at the two ways to fix.

**Answer**: *Pending*

---

### Q4: `PrFeedbackMonitorService` scope
**Context**: The exact same `if (this.state.lastWebhookEvent === null) return;` pattern exists in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:756-762`, with the same `webhookHealthy`/`lastWebhookEvent` state fields and the same `updateAdaptivePolling()` guard. Unlike `LabelMonitorService`, `server.ts` does not override `config.prMonitor.adaptivePolling` on the smee-configured path, so this service's dead-branch behavior depends on how `config.prMonitor` is populated — but the defect shape is identical. The spec's title, FR wording, and Assumptions §1 all say "scoped to `LabelMonitorService`", but that leaves the twin bug unfixed.
**Question**: Is `PrFeedbackMonitorService` in scope for this PR?
**Options**:
- A: **In scope — fix both.** Apply the same mechanism (per Q1) to both services in this PR. FR-007 unit coverage extends to both. Rationale: same code, same bug, same evidence — splitting the fix wastes a PR round-trip and leaves a known-bad code path live.
- B: **Out of scope — LabelMonitor only, follow-up issue for PrFeedback.** Keep the surface small; land LabelMonitor first, file a companion issue for PrFeedback that reuses the same clarification answers. Rationale: preserves the "one issue = one bug" hygiene the spec set up.
- C: **Extract shared helper, both callers migrate.** Pull `updateAdaptivePolling()` + supporting state into a shared module (e.g. `adaptive-poll-controller.ts`) that both services delegate to. Both callers get the fix by construction; regression test lives against the helper.

**Answer**: *Pending*

---

### Q5: State model for `webhooksConfigured` signal
**Context**: `MonitorState` currently carries `{ webhookHealthy: boolean, lastWebhookEvent: number | null, ... }`. Whether the smee-less signal lives in `webhookHealthy` (Q1 option B), in a *new* `webhooksConfigured: boolean` field on state (any Q1 option), or is derived from options at each read affects: FR-004's log-field naming, FR-007's test surface, and how the twin-service refactor in Q4 option C looks. This is largely determined by Q1 but not fully — some Q1 answers admit multiple state-model shapes.
**Question**: How is the "webhooks were never configured" signal represented in state?
**Options**:
- A: **New `webhooksConfigured: boolean` on `MonitorState`,** set once at construction from the constructor arg and read wherever needed. `webhookHealthy` stays semantically "is the configured webhook path currently delivering." Log line uses `{ webhooksConfigured: false }` per the spec's example.
- B: **Reuse `webhookHealthy: false`** at construction on smee-less clusters. No new state field; distinguish log lines with a distinct `reason: 'webhooks-not-configured'` string. Compact but overloads `webhookHealthy` semantically ("healthy" and "configured" now mean the same thing on this branch).
- C: **No state field — hold on `options` only.** `webhooksConfigured` is a constructor-time constant read directly from `this.options` at every use site; no `state` mutation, no serialization surface. Least state, most reads.

**Answer**: *Pending*
