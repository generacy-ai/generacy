# Clarifications

**Feature**: orchestrator monitors stuck in poll mode on auto-provisioned smee channel
**Issue**: [generacy-ai/generacy#987](https://github.com/generacy-ai/generacy/issues/987)

## Batch 1 — 2026-07-18

### Q1: Setter reversibility
**Context**: FR-001 defines `setWebhooksConfigured(configured: boolean, opts?)` and the spec only nails down the `true` case (flip on, set base, disable adaptive). The signature admits `false`, but nothing in the spec says whether the fix needs it — and if it does, the operational contract (does `false` re-enable adaptive polling? does it re-freeze the fast interval? does it re-emit `webhooks-not-configured`?) is undefined. Matters because if `startSmeePipeline` succeeds, sets the flag `true`, and the smee receiver later dies (network drop, channel closed, receiver crashes), monitors would keep polling at the safety-net cadence forever with no escalation path back to `webhooks-not-configured` fast-poll — the exact failure mode the pre-fix adaptive controller was designed to catch.
**Question**: Does the setter need to support `setWebhooksConfigured(false, ...)` for smee-receiver-failure recovery, and if so, what is its behavior contract?
**Options**:
- A: **One-way only** — signature is effectively `setWebhooksConfigured(true, ...)`. `false` is not part of the API. Smee receiver death is out of scope; existing `webhook-stale` branch (see Q2) handles all post-flip escalation.
- B: **Bidirectional, symmetric** — `false` reverts `state.webhooksConfigured = false`, restores `options.adaptivePolling = true`, and (if `opts.basePollIntervalMs` provided) resets the interval. `startSmeePipeline`'s cleanup / receiver-error path calls it. `webhooks-not-configured` reason can re-fire after `true → false`.
- C: **Bidirectional, but `false` only flips the flag** — sets `state.webhooksConfigured = false`, leaves `options.adaptivePolling` and `basePollIntervalMs` where they are. Callers handle the rest.

**Answer**: *Pending*

### Q2: Adaptive escalation after the flip
**Context**: FR-001 (c) says `setWebhooksConfigured(true)` sets `options.adaptivePolling = false`. FR-005 says "`decideAdaptivePoll` for that monitor must return `reason: 'quiet'` (or `'webhook-stale'` on genuine staleness, or `'webhook-recovered'` on recovery)". These are in tension: with `adaptivePolling = false`, the `adaptive-poll-controller.ts` matrix (per the file's `:90-166` region referenced in the spec) short-circuits before the `webhook-stale → to-fast` branch — meaning after the flip, genuine webhook drought would silently hold the monitor at the fallback cadence with no escalation, defeating the safety net. Alternatively, FR-005 is describing the theoretically reachable set and the fix intentionally cuts off the `webhook-stale` fast-poll (because monitors are supposed to be event-driven now, not stale-polling). Choice determines both the setter's `options.adaptivePolling` behavior and how much of the current controller matrix stays reachable for these monitors.
**Question**: After `setWebhooksConfigured(true, ...)`, should the monitor still escalate to the fast interval on `webhook-stale`, or hold at fallback cadence indefinitely?
**Options**:
- A: **Escalate on staleness** — FR-001 (c) is amended: setter does **not** set `options.adaptivePolling = false`. It leaves adaptive polling on; the controller matrix keeps its `webhook-stale → to-fast` path but never re-enters `webhooks-not-configured`. Safety net preserved for smee outages.
- B: **Hold at fallback** — keep FR-001 (c) as written. `options.adaptivePolling = false`. `webhook-stale` never escalates for these monitors post-flip. FR-005's mention of `webhook-stale` is aspirational; realistic post-flip reasons are `quiet` only. Smee outages surface via other health signals, not by re-escalating poll cadence.
- C: **Escalate once, then hold** — keep `adaptivePolling = false` but add an escape hatch: if no webhook events have been recorded for `basePoll * N` after the flip, the setter (or a follow-on mechanism) re-flips to `false` (couples with Q1).

**Answer**: *Pending*

### Q3: FR-004 wiring scope
**Context**: FR-004 says the four monitors' `recordWebhookEvent()` must be called from the inbound webhook path. The Assumptions section (line 82) explicitly hedges: "If FR-004 verification finds that PR-feedback / merge-conflict / clarification-answer inbound webhooks don't reach their monitor's `recordWebhookEvent`, this spec expands to include that wiring. Otherwise it stays out of scope." This is a conditional-scope hedge that blocks tasks planning: the tasks list, changeset scope, and the acceptance-criterion count all depend on whether wiring is in scope from day one or is a runtime-verification-then-maybe follow-up.
**Question**: Is the `SmeeWebhookReceiver` (or equivalent inbound webhook dispatcher) wiring for PR-feedback, merge-conflict, and clarification-answer `recordWebhookEvent()` in scope for this spec's PR?
**Options**:
- A: **In scope, unconditional** — verification is part of the implementation. If any of the three services lacks a `recordWebhookEvent()` call from the inbound webhook path, wire it as part of #987. Tasks list, changeset, and acceptance criteria are sized for this.
- B: **Verification-only, in scope; wiring deferred** — the fix verifies via code-read + logging that the wiring exists or doesn't. If gaps are found, a follow-up issue is filed and #987 lands without them. Post-flip monitors would sit at fallback cadence even though webhooks land, until the follow-up ships.
- C: **Out of scope entirely** — assume wiring exists. If it doesn't, that's a separate defect. #987 only fixes the flag/cadence gate. Weakest coupling to #952/#953 integration story.

**Answer**: *Pending*

### Q4: ClarificationAnswerMonitorService constructor shape
**Context**: FR-003 says the hardcoded `webhooksConfigured: false` at `clarification-answer-monitor-service.ts:135` is "removed in favor of a constructor arg + the FR-001 setter, matching the other three services." Two shapes match this description with different blast radii: (1) constructor gains a **new required `webhooksConfigured: boolean` parameter**, `server.ts` construction site updated to pass `config.smee.channelUrl != null` (mirrors `:493` for the other three), or (2) constructor accepts it as **optional with default `false`**, `server.ts` unchanged, setter provides post-construction mutation. The spec doesn't nail down which. Matters for tasks list (do we touch the construction site?), for the FR-003 test coverage, and for interface backward-compat with any downstream consumer of the service.
**Question**: What is the target constructor signature for `ClarificationAnswerMonitorService` after FR-003?
**Options**:
- A: **New required parameter** — `webhooksConfigured: boolean` becomes required. `server.ts` construction site updated to pass `config.smee.channelUrl != null` (mirrors the other three's `:493` pattern). Symmetrical with the other three services, but touches one more file.
- B: **Optional with default `false`** — `webhooksConfigured?: boolean = false`. `server.ts` construction site unchanged. Setter carries all the runtime state change. Minimum diff; asymmetric with the other three.
- C: **Optional with default `false`, but `server.ts` still updated to pass explicitly** — matches (A) in behavior at the current call site but keeps the parameter optional for other consumers / tests.

**Answer**: *Pending*

### Q5: Setter call timing inside `startSmeePipeline`
**Context**: FR-002 says `startSmeePipeline(channelUrl)` calls the setter on every constructed monitor. The pipeline internally (a) starts the smee receiver and (b) sets up the GitHub webhook. Both are network operations that can fail (receiver fails to connect; webhook registration returns 4xx). The spec doesn't specify whether the setter fires before, during, or after these succeed. Consequential: if the setter fires unconditionally at the top and receiver-connect fails, monitors sit at fallback cadence believing webhooks are live but events never land — an outage where the safety net is intentionally disabled. If it fires only after both succeed, a slow webhook registration extends the fast-adaptive window unnecessarily.
**Question**: At what point inside `startSmeePipeline(channelUrl)` should `setWebhooksConfigured(true, ...)` fire?
**Options**:
- A: **Top of function, unconditional** — flag flips before receiver connect and webhook registration. Simplest, but a receiver-connect failure leaves monitors at fallback cadence with no events landing.
- B: **After receiver connects** — flag flips once the smee receiver reports `Connected`. Webhook registration may or may not be done. Assumes receiver-connect is the critical path (webhook registration failure is recoverable by GitHub retry or manual repair).
- C: **After both receiver connects AND webhook registration succeeds** — most conservative. Extends the pre-flip window until both are healthy. On the auto-provisioned path, webhook registration is where the bulk of the async work happens; this could add a noticeable delay before the flip.
- D: **After receiver connects; webhook-registration failure triggers `setWebhooksConfigured(false)` (couples with Q1 = B/C)** — hybrid. Flag flips on receiver-up. If webhook registration then fails, revert.

**Answer**: *Pending*
