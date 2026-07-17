# Clarifications for #978 — Cockpit doorbell subscribes to smee stream

## Batch 1 — 2026-07-17

### Q1: SSE event coverage and mapping to CockpitStreamEvent
**Context**: FR-004 lists `x-github-event ∈ { issues, pull_request, check_run, check_suite }`, but the existing `CockpitEventSchema` (`packages/generacy/src/cli/commands/cockpit/watch/emit.ts`) has a fixed `event` enum: `label-change | issue-closed | pr-merged | pr-closed | pr-checks`. The spec does not (a) enumerate the exact `x-github-event` + `action` combinations that should produce a doorbell emit, (b) say whether `pull_request_review` / `pull_request_review_comment` / `issue_comment` are also in scope (these matter for `on-sibling-review` gate wakes from #692 and for `/cockpit:auto` reacting to review-requested-changes), or (c) specify how `from`/`to` states are computed from a single webhook payload without a full snapshot diff.
**Question**: Which `x-github-event` + `action` combinations should the smee-mode doorbell translate into `CockpitStreamEvent` emissions, and how do they map to the existing `event` enum values? Are review / comment events in scope, or strictly out of scope for this feature?
**Options**:
- A: In-scope = today's poll-derived signals only. Mapping: `issues.labeled`/`issues.unlabeled` → `label-change`; `issues.closed` → `issue-closed`; `pull_request.closed` (merged=true) → `pr-merged`; `pull_request.closed` (merged=false) → `pr-closed`; `check_run.completed` OR `check_suite.completed` → `pr-checks`. `pull_request_review`, `pull_request_review_comment`, `issue_comment` are out of scope. `from`/`to` computed from payload's `labels[]` snapshot with best-effort accuracy.
- B: Same as A, plus `pull_request_review.submitted` mapped to a NEW `pr-review` enum value (requires `CockpitEventSchema` rev; consumers must be forward-compatible). Broadens `on-sibling-review` gate coverage.
- C: Same as A, plus `pull_request_review.submitted` AND `issue_comment.created` (covers gate-satisfying developer comments). Two new enum values.
- D: Doorbell emits a generic `webhook` line for every ref-set-matching payload; typed decoding remains the sole responsibility of `cockpit_await_events`. Breaks the shipped stdout contract; requires agency#431 update.

**Answer**: *Pending*

### Q2: Ref-set refresh cadence in smee mode
**Context**: FR-003 requires filtering SSE payloads by the epic's ref set (epic + children + tracking issue), derived from `resolveEpic(...)`. In poll mode, `event-bus-registry.ts` re-runs `resolveEpic` every `EPIC_REFRESH_CYCLES = 10` cycles (~5 min at 30 s cadence). In smee mode there is no poll cadence — the spec is silent on when the ref set is refreshed. If a child issue is added to the epic body mid-run, its webhooks will be silently dropped by the filter until refresh.
**Question**: When should `resolveEpic` re-run in smee mode to keep the ref-set filter current with epic-body edits?
**Options**:
- A: Startup only. Epic body treated as immutable during a single doorbell run; adding a child requires restarting the doorbell process. Zero background GitHub calls.
- B: Fixed-interval background refresh (e.g., every 5 min) independent of SSE, matching poll mode's effective cadence.
- C: Refresh only when an SSE payload arrives for the epic issue itself (`issue.number === epicNumber && action ∈ { edited, labeled, unlabeled }`). Zero background calls; but misses edits made via `gh api` PATCH that don't fire an `issues.edited` webhook.
- D: Hybrid — startup + on-epic-issue-payload (Option C) + safety-net timer (~10 min) so silent gaps are bounded.

**Answer**: *Pending*

### Q3: Runtime SSE loss — reconnect forever, or eventually demote to poll?
**Context**: FR-002 enumerates fallback triggers as pre-first-event ("SSE connect fails, or SSE errors before first event"). FR-005 mandates exponential-backoff reconnect (5 s → 300 s cap). But the spec is silent on what happens if SSE connected, delivered events, then reconnects fail persistently (e.g., smee.io outage lasting hours). The orchestrator's `SmeeWebhookReceiver` reconnects forever. The doorbell process is short-lived-ish (one epic run) — an infinite reconnect loop with no wake signal could silently strand `/cockpit:auto`.
**Question**: What is the runtime SSE-loss policy for the doorbell?
**Options**:
- A: Reconnect forever with capped backoff. Never demote to poll. Rely on `ScheduleWakeup` heartbeat (FR-011) to cover missed wakes. Matches orchestrator receiver.
- B: After N consecutive failed reconnects (e.g., 5, ≈2.5 min elapsed), demote to poll-fallback for the remainder of the run. Emit `cockpit doorbell: source=poll-fallback reason=smee-runtime-lost` on stderr. Never re-attempt smee.
- C: After X minutes without a successful reconnect (e.g., 15), demote to poll-fallback with same stderr log. Never re-attempt smee.
- D: Demote to poll-fallback AND periodically retry smee-mode promotion (e.g., every 5 min); log each transition.

**Answer**: *Pending*

### Q4: Aggregate events (phase-complete, epic-complete) in smee mode
**Context**: The current poll cycle drives `computeAggregateEvents(...)` from a `SnapshotMap` diff to emit `phase-complete` and `epic-complete` events (`packages/generacy/src/cli/commands/cockpit/watch/aggregate.ts`). SSE payloads carry per-item state, not aggregate roll-up state. The `--exit-on-epic-complete` flag depends on `epic-complete` being emitted. FR-007 forbids the doorbell from acquiring `acquireEpicBus` in smee mode. If aggregate events aren't computed, `--exit-on-epic-complete` silently never fires in smee mode — a functional regression on smee-live clusters.
**Question**: How should smee-mode compute `phase-complete` / `epic-complete`?
**Options**:
- A: On any SSE payload matching a `completed:*` label OR an `issues.closed` action, run a single on-demand `resolveEpic` + snapshot refresh, diff, emit aggregate events. Cost: ~1 gh call per completed-signal, only when relevant.
- B: Keep a low-frequency in-process background poll (e.g., every 5 min) solely for aggregate computation; SSE drives all `issue-transition` events. `--exit-on-epic-complete` fires within ≤5 min instead of ~3 s. Hybrid.
- C: Do not emit aggregate events in smee mode. `--exit-on-epic-complete` is broken for smee-live clusters (skill must poll a separate signal). Simplest; regressive.
- D: In smee mode still acquire the shared `EpicEventBus` at a much longer poll interval (e.g., 5 min) — SSE drives `issue-transition` events, poll drives aggregates. Violates FR-007 as written; would require FR-007 revision.

**Answer**: *Pending*

### Q5: `armed\n` line timing in smee mode
**Context**: Today's doorbell writes `armed\n` to stdout immediately after `acquireEpicBus` returns, before any wake signal is possible. The agency#431 skill uses `armed\n` as its "doorbell process is ready" signal. In smee mode there is no `acquireEpicBus`; the spec does not say whether `armed\n` still fires before smee-source selection, after smee is confirmed connected, or after fallback selection has settled. The timing determines what the skill can rely on when it sees `armed\n`.
**Question**: When should `armed\n` be written in smee mode?
**Options**:
- A: Unconditionally, immediately after startup argument validation — same as today. Skill treats `armed\n` as "process is up and will attempt wake"; it makes no statement about whether smee OR poll is the eventual source. FR-006 source= line follows separately.
- B: After the source is selected (smee-connected OR poll-fallback bus acquired), i.e., only once the doorbell has a working wake path. Skill can treat `armed\n` as "wake path is live" — stronger guarantee, but delays the ready signal by the SSE-connect / poll-acquire latency.
- C: Unconditionally at startup (matches A), AND additionally emit the FR-006 `source=…` stderr line as the "source settled" signal. Skill relies on `armed\n` for liveness only.

**Answer**: *Pending*
