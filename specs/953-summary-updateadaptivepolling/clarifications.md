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

**Answer**: **A — skip adaptive polling; fixed-fast interval from the start.**

"Unhealthy" implies a condition that could recover. A cluster with no smee channel and no webhook ingress has no real-time path to recover *to* — the absence is structural, and it is known at construction time rather than observed at runtime. **B** would emit `Webhooks appear unhealthy, increasing poll frequency` on every boot of every smee-less cluster, which describes a transient degradation where the truth is a permanent configuration fact. **C** spends `basePollIntervalMs * 2` rediscovering something already available at construction. A is the honest model: compute `basePollIntervalMs / ADAPTIVE_DIVISOR` clamped to `MIN_POLL_INTERVAL_MS` once and use it as the steady state.

Note for the implementer: at the default 30s base, LabelMonitor's `ADAPTIVE_DIVISOR = 3` (`label-monitor-service.ts:59`) gives exactly 10s, which is exactly `MIN_POLL_INTERVAL_MS` (`:58`). **The clamp binds at the default configuration** — a test asserting the fast interval at defaults is really asserting the clamp, not the divide. Pick test values that separate the two.

---

### Q2: Startup grace period
**Context**: FR-002 says "immediately (or via a bounded startup grace)." The choice affects SC-001 (target: ≤ `basePollIntervalMs / ADAPTIVE_DIVISOR` "after ≤ 1 cycle") — a non-zero grace shifts when the fast interval is first observed. Option C in Q1 inherently uses a `basePollIntervalMs * 2` grace; options A and B can be engaged immediately or with a grace. Independent from Q1 only if Q1 → A or B.
**Question**: If Q1 is A or B, is there any startup grace before the fast interval takes effect?
**Options**:
- A: **No grace — engage on cycle 1.** Fast interval is used from the first poll after construction. Simplest, matches SC-001's "≤ 1 cycle" target most directly.
- B: **Bounded grace equal to `basePollIntervalMs`** (one base cycle). Polls at base for one cycle, then flips to adaptive on cycle 2. Rationale: minimal accommodation for services that haven't finished initialization; still bounded and predictable.
- C: **N/A — Q1 answer is C** (existing `basePollIntervalMs * 2` threshold defines the grace by construction).

**Answer**: **A — no grace, engage on cycle 1.**

Follows from Q1=A. The signal is a constructor-time constant, so there is no initialization race to accommodate — poll cycle 1 already runs after construction completes. A grace period would delay the correct interval by one cycle in exchange for no information.

---

### Q3: `adaptivePolling: false` operator opt-out semantics
**Context**: FR-005 says the `adaptivePolling` flag "MUST have a reachable effect for at least one code path" with preference to "honor it (default `true`)." Today the flag is only ever read on the smee-less path (smee-configured path force-sets it to `false`). If an operator explicitly sets `adaptivePolling: false` on a smee-less cluster, the fix must define what interval they get — otherwise the flag remains ambiguous. Impacts config-schema validation and unit-test cases for FR-007.
**Question**: When `adaptivePolling === false` on a smee-less cluster (operator opt-out), which interval is used?
**Options**:
- A: **Stay at `basePollIntervalMs` indefinitely.** Operator opt-out preserves current stuck-at-base behavior on purpose — the flag is a knob for "I don't want the fast poll rate for API-cost or rate-limit reasons." Matches the natural reading of "opt out of adaptive polling."
- B: **Use `fallbackPollIntervalMs` (the smee-configured fallback).** Treat opt-out as "poll at the pre-configured fallback cadence, whatever that is." Consistent with the smee-configured branch.
- C: **Reject the config combination at load time.** `adaptivePolling: false` + no smee is a configuration error (the flag has no meaning without a real-time path). Fail loud in `config/loader.ts` with a clear message pointing at the two ways to fix.

**Answer**: **A — stay at `basePollIntervalMs` indefinitely.**

Natural reading of the flag, and it protects a legitimate use case: an operator on a tight GitHub rate-limit budget may deliberately want the slower cadence on a smee-less cluster. Tripling the request rate against their wishes because they *also* lack a webhook is not a favour. **B** conflates two unrelated settings — `fallbackPollIntervalMs` (default 300000, `config/schema.ts:242`) is the *smee-configured* safety-net cadence; it has no meaning on a cluster with no smee. **C** rejects a configuration that is both valid and useful.

A also satisfies FR-005 cleanly:

| `adaptivePolling` | smee | interval |
|---|---|---|
| `true` (default) | absent | fast (`base / DIVISOR`, clamped) |
| `false` | absent | `basePollIntervalMs` |

Two distinct, reachable behaviours — so the flag stops being dead code, which is the point of FR-005.

---

### Q4: `PrFeedbackMonitorService` scope
**Context**: The exact same `if (this.state.lastWebhookEvent === null) return;` pattern exists in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:756-762`, with the same `webhookHealthy`/`lastWebhookEvent` state fields and the same `updateAdaptivePolling()` guard. Unlike `LabelMonitorService`, `server.ts` does not override `config.prMonitor.adaptivePolling` on the smee-configured path, so this service's dead-branch behavior depends on how `config.prMonitor` is populated — but the defect shape is identical. The spec's title, FR wording, and Assumptions §1 all say "scoped to `LabelMonitorService`", but that leaves the twin bug unfixed.
**Question**: Is `PrFeedbackMonitorService` in scope for this PR?
**Options**:
- A: **In scope — fix both.** Apply the same mechanism (per Q1) to both services in this PR. FR-007 unit coverage extends to both. Rationale: same code, same bug, same evidence — splitting the fix wastes a PR round-trip and leaves a known-bad code path live.
- B: **Out of scope — LabelMonitor only, follow-up issue for PrFeedback.** Keep the surface small; land LabelMonitor first, file a companion issue for PrFeedback that reuses the same clarification answers. Rationale: preserves the "one issue = one bug" hygiene the spec set up.
- C: **Extract shared helper, both callers migrate.** Pull `updateAdaptivePolling()` + supporting state into a shared module (e.g. `adaptive-poll-controller.ts`) that both services delegate to. Both callers get the fix by construction; regression test lives against the helper.

**Answer**: **C — extract shared helper; all THREE services migrate. (Premise correction: there are three affected services, not two.)**

`services/merge-conflict-monitor-service.ts:346` carries the identical early return, with the same `webhookHealthy` / `lastWebhookEvent` state:

```ts
private updateAdaptivePolling(): void {
  if (this.state.lastWebhookEvent === null) return;
  ...
}
```

And it is **worse than the other two**: `MergeConflictMonitorService.recordWebhookEvent()` (`:332`) has **no callers anywhere in the codebase** — only its own definition. Nothing can ever set its `lastWebhookEvent`, so its adaptive polling is dead on *every* cluster in *every* configuration. Not "dead on smee-less clusters" — dead unconditionally.

`PrFeedbackMonitorService` is nearly as bad: `SmeeWebhookReceiver` is typed to `LabelMonitorService` (`smee-receiver.ts:57`) and filters to `x-github-event: issues` (`:210`), so **smee never feeds PrFeedback at all**. Its only event source is the direct HTTP route at `pr-webhooks.ts:119` — which a smee-based cluster does not use, because the entire reason to run smee is the absence of public ingress. So on exactly the clusters #952 exists to create, PrFeedback's adaptive polling is dead too.

That reframes the choice. Option B doesn't leave *one* known-bad path live, it leaves two — one of which is broken on every cluster we operate. Option A fixes two of three and leaves the universally-dead one.

**C, extended to all three.** The bug exists *because* this block was copy-pasted three times; fixing the copies in place preserves the mechanism that produced it. Note the constants have already drifted, so the helper must take the divisor as a parameter:

| Service | `ADAPTIVE_DIVISOR` | `MIN_POLL_INTERVAL_MS` |
|---|---|---|
| `label-monitor-service.ts` | 3 (`:59`) | 10000 (`:58`) |
| `pr-feedback-monitor-service.ts` | 2 (`:42`) | 10000 (`:36`) |
| `merge-conflict-monitor-service.ts` | 2 (`:34`) | 10_000 (`:29`) |

The divergence is documented in-code at `pr-feedback-monitor-service.ts:40` ("This differs from LabelMonitorService which uses ADAPTIVE_DIVISOR = 3"), so it is intentional and must be preserved, not normalised away. FR-007's regression test should live against the helper, with a thin per-service test that each passes its own divisor through.

**Scope note:** larger diff than a bugfix workflow usually carries, deliberately. Fallback if reviewer wants it split: land the helper + LabelMonitor here, migrate PrFeedback and MergeConflict in an immediate follow-up. Do not land a LabelMonitor-only point fix that leaves the other two copies untouched.

---

### Q5: State model for `webhooksConfigured` signal
**Context**: `MonitorState` currently carries `{ webhookHealthy: boolean, lastWebhookEvent: number | null, ... }`. Whether the smee-less signal lives in `webhookHealthy` (Q1 option B), in a *new* `webhooksConfigured: boolean` field on state (any Q1 option), or is derived from options at each read affects: FR-004's log-field naming, FR-007's test surface, and how the twin-service refactor in Q4 option C looks. This is largely determined by Q1 but not fully — some Q1 answers admit multiple state-model shapes.
**Question**: How is the "webhooks were never configured" signal represented in state?
**Options**:
- A: **New `webhooksConfigured: boolean` on `MonitorState`,** set once at construction from the constructor arg and read wherever needed. `webhookHealthy` stays semantically "is the configured webhook path currently delivering." Log line uses `{ webhooksConfigured: false }` per the spec's example.
- B: **Reuse `webhookHealthy: false`** at construction on smee-less clusters. No new state field; distinguish log lines with a distinct `reason: 'webhooks-not-configured'` string. Compact but overloads `webhookHealthy` semantically ("healthy" and "configured" now mean the same thing on this branch).
- C: **No state field — hold on `options` only.** `webhooksConfigured` is a constructor-time constant read directly from `this.options` at every use site; no `state` mutation, no serialization surface. Least state, most reads.

**Answer**: **A — new `webhooksConfigured: boolean` on `MonitorState`.**

Keeps `webhookHealthy` meaning "the configured webhook path is currently delivering" and adds a separate field for "a webhook path exists at all". Two genuinely different facts. **B**'s overload is exactly the mistake that produced this bug — `lastWebhookEvent === null` was made to carry both "no data yet" and "never configured", and the code chose the wrong reading. The `reason: 'webhooks-not-configured'` string B proposes is an admission that the two states need distinguishing anyway. A over **C** because FR-004's log line and FR-007's tests both want to read the value, and `getState()` already exposes state for assertions. Holding it only on `options` splits the test surface and the log-field surface away from where every other monitor fact lives.

---

## Batch 2 — 2026-07-16

### Q6: `webhooksConfigured` derivation per service
**Context**: Q4=C expanded scope to three services (`LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`), and Q1=A + Q5=A pin the mechanism to a construction-time `webhooksConfigured: boolean`. But each service has a different webhook feeder, so the derivation rule differs by service:

- **`LabelMonitorService`** is fed by `SmeeWebhookReceiver`. Derivation is well-defined: `config.smee.channelUrl != null`.
- **`PrFeedbackMonitorService`** is *not* fed by smee (`smee-receiver.ts:57` is typed to LabelMonitor, and its stream filters to `x-github-event: issues`). Its only feeder is the direct HTTP webhook route at `pr-webhooks.ts:119`, which is always registered but only accepts payloads when `PR_MONITOR_WEBHOOK_SECRET` is set (`config/loader.ts:187–192`). Note that as Q4's answer states, a smee-based cluster does not use direct HTTP ingress at all — so treating "smee configured" as "webhooks configured" for PrFeedback is wrong on that population.
- **`MergeConflictMonitorService`** has no feeder anywhere — `recordWebhookEvent()` has no callers. Under the current codebase `webhooksConfigured` for this service is always `false`. Adding a feeder is explicitly out of scope.

The implementer needs a rule for each. FR-002 acceptance ("service polls at the fixed-fast interval when `webhooksConfigured === false`") is only testable once the derivation is fixed.

**Question**: How is `webhooksConfigured` derived for each of the three services?
**Options**:
- A: **Per-service, purpose-built derivation** (recommended, aligned with Q4 rationale).
  - `LabelMonitor`: `config.smee.channelUrl != null` (unchanged from spec).
  - `PrFeedback`: `PR_MONITOR_WEBHOOK_SECRET` env-var is set — proxy for "the direct HTTP route is intended to receive traffic." Surfaced through config (e.g. `config.prMonitor.webhookSecret != null` after loader).
  - `MergeConflict`: hardcoded `false` at the construction callsite in `server.ts` (no feeder exists; TODO comment cross-references the "no callers of `recordWebhookEvent()`" fact).
- B: **Single derived config field `config.webhooks.configured`,** computed once in `config/loader.ts` as `smee.channelUrl != null || PR_MONITOR_WEBHOOK_SECRET != null || false`. All three services take the same value. Simpler shape, but glosses over per-service feeder differences: `PrFeedback` reads `true` on a smee-only cluster (smee doesn't feed it), and `MergeConflict` reads `true` when it has no feeder at all.
- C: **Anchor on smee alone.** `webhooksConfigured` for every service ⇔ `config.smee.channelUrl != null`. Rejected by Q4's rationale (smee doesn't feed PrFeedback) — listed for completeness, and to make the trade-off explicit if the reviewer wants LabelMonitor-symmetric behaviour for reasons like log-line consistency.

**Answer**: A, with one premise corrected and one consequence handled

**The shape of A is right** — per-service derivation, because the feeders genuinely differ. But A's rule for `PrFeedback` rests on an inverted premise and has to change.

#### Correction: `PR_MONITOR_WEBHOOK_SECRET` does not gate the route

The question states the direct HTTP route "is always registered but only accepts payloads when `PR_MONITOR_WEBHOOK_SECRET` is set (`config/loader.ts:187–192`)". It is the reverse. `routes/pr-webhooks.ts:11-14`:

```ts
function verifySignature(secret: string | undefined, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!secret) {
    // No secret configured — skip verification (dev mode)
    return true;
  }
  ...
}
```

With **no** secret the route accepts *every* payload unverified. With a secret it accepts only correctly-signed ones. The secret makes the route **more** restrictive, not less. Registration is likewise unconditional — `server.ts:715`:

```ts
const hasWebhookRoutes = labelMonitorService || prFeedbackMonitorService;
```

`routes/webhooks.ts:10-13` has the identical `verifySignature` shape for the label route, so this is a codebase-wide convention, not a PR-route quirk.

So the secret is an **authentication** control, orthogonal to whether a feeder exists. As a proxy for `webhooksConfigured` it fails in both directions:

- **Secret set, no GitHub webhook pointing at the cluster** → `webhooksConfigured: true`, no event ever arrives, service sits at base interval forever. That is precisely the bug this issue exists to fix, reintroduced through a new field.
- **No secret, real webhook delivering** (the dev-mode ingress the comment describes) → `webhooksConfigured: false` while events are actively flowing, so the service polls fast for no reason.

#### The derivation

- **`LabelMonitorService`**: `config.smee.channelUrl != null` — as the question states, and it is well-founded for a reason worth recording: when smee is configured, `webhookSetupService.ensureWebhooks` (`server.ts:824-826`) actually **creates** the GitHub webhook against that channel. So this isn't an assumption that events *might* arrive; the same startup path that sets the flag also guarantees the feeder. No other service has an equivalent guarantee.

- **`PrFeedbackMonitorService`**: **`false`** — not "secret is set". Nothing available at construction can confirm a feeder. Smee doesn't feed it (`smee-receiver.ts:57` is typed to `LabelMonitorService`, `:210` filters to `x-github-event: issues`), and whether GitHub can reach the direct route depends on public ingress the process cannot observe from the inside. `false` is the honest value under the current codebase.

- **`MergeConflictMonitorService`**: **`false`**, hardcoded at the `server.ts` callsite with the TODO cross-reference, exactly as A proposes. `recordWebhookEvent()` (`:332`) has no callers anywhere, so no other value is reachable.

#### Required consequence: preserve the current cadence for the two twins

**This part changes the amended spec, and it should.** Setting `webhooksConfigured: false` for PrFeedback and MergeConflict is correct, but under FR-002 as written it silently doubles GitHub API load on every cluster:

- `config.prMonitor.adaptivePolling` defaults to **`true`** (`config/schema.ts:143`)
- `MergeConflictMonitorService` shares `config.prMonitor` (`server.ts:522`, per the `#898` comment)
- both use `ADAPTIVE_DIVISOR = 2` (`pr-feedback-monitor-service.ts:42`, `merge-conflict-monitor-service.ts:34`) on a 60000ms base, and `MIN_POLL_INTERVAL_MS = 10000` does not bind

So `60s → 30s` for both, immediately, on every existing cluster, as a side effect of a bugfix titled "adaptive polling never engages".

**Set `config.prMonitor.adaptivePolling` to default `false`** so both stay at 60s. Operators who want 30s opt in via `PR_MONITOR_ADAPTIVE_POLLING=true` (`config/loader.ts:194-200`, already wired).

The reasoning is not merely caution about API budget. The two cases are genuinely different:

| Service | Base | Was the base tuned assuming a real-time path? |
|---|---|---|
| `LabelMonitor` | 30s | **Yes** — smee is the real-time path, polling is the safety net. Compensating when smee is absent is coherent: we are restoring an assumption the tuning depended on. |
| `PrFeedback` | 60s | **No** — its only feeder needs public ingress that smee-based clusters don't have by definition. |
| `MergeConflict` | 60s | **No** — it has never had a feeder at all, on any cluster, in any configuration. |

The 60s base for the twins was therefore *already* tuned in the world where webhooks never arrive — that is the only world they have ever run in. Halving it is not "compensating for a lost real-time path"; it is re-tuning a cadence that was already correct for reality, on the strength of a flag that has never once been true. LabelMonitor is the only service where the fast interval restores intended behaviour rather than inventing new behaviour.

This keeps FR-005 satisfied for `prMonitor` as well, and more meaningfully than before — `adaptivePolling` becomes a real, reachable knob on those services (`true` → 30s, `false` → 60s) instead of a flag whose only reachable value is dictated by a field that can never be anything but `false`.

**Scope note:** confirmed before answering. If the reviewer prefers the uniform rule (all three fast when `webhooksConfigured === false`), the alternative is to ship the doubling deliberately and say so in the changeset — but it should be a stated decision with the API-load figure attached, not a silent default flip discovered later on a rate-limited cluster.

#### On B and C

**B** (single `config.webhooks.configured`) is unsound for a reason beyond the "glosses over differences" note in the question: its formula `smee.channelUrl != null || PR_MONITOR_WEBHOOK_SECRET != null || false` inherits the inverted secret premise **and** reads `true` on a smee-only cluster for two services that smee provably does not feed. On the exact population #952 creates, B produces the wrong answer for two of three services — it would leave PrFeedback and MergeConflict believing they have a real-time path while their `lastWebhookEvent` stays `null` forever. That is this bug wearing a new field name.

**C** is correctly self-identified as rejected. Worth adding: C is the *status quo* dressed as a fix. Anchoring all three on smee gives MergeConflict `webhooksConfigured: true` on every smee cluster, which is exactly as wrong as today's `lastWebhookEvent === null` early return, just spelled differently. Log-line consistency is not worth encoding a known-false claim into state.
