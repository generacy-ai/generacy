# Feature Specification: Cockpit doorbell subscribes to smee stream (revised FR-011)

**Branch**: `978-summary-generacy-cockpit` | **Date**: 2026-07-17 | **Status**: Draft
**Source**: [#978](https://github.com/generacy-ai/generacy/issues/978)

## Summary

The `generacy cockpit doorbell` surface shipped by #970 (engine) / agency#431 (skill) is **poll-fed, not smee-fed**. It subscribes to the cockpit in-process event-bus (`packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts` → `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`), which is driven by a 30 s GitHub poll loop (`DEFAULT_INTERVAL_MS = 30_000`). On smee-live clusters the doorbell therefore ignores the real-time webhook stream that is already arriving in ~1–3 s and re-derives the same transitions ~25 s later via `gh`.

The revised FR-011 posted on #970 (doorbell subscribes to the smee stream, poll only as fallback) landed after implementation was already underway and was not built. This feature implements it.

This is "Cause 2" of `/cockpit:auto` notification latency. "Cause 1" — the orchestrator's smee being unfed because the repo webhook isn't registered — is tracked in **#972**. Both must land for near-instant notification; #972 alone does not speed up the doorbell.

## Context

- Doorbell command entry: `packages/generacy/src/cli/commands/cockpit/doorbell.ts` (`runDoorbell` → `acquireEpicBus` → `subscribeAndEmit`).
- Persisted smee channel URL: `/var/lib/generacy/smee-channel` (override `GENERACY_SMEE_CHANNEL_FILE_PATH`), written by `SmeeChannelResolver` in the orchestrator (`packages/orchestrator/src/services/smee-channel-resolver.ts`). Contents validated by `SMEE_URL_PATTERN`.
- SSE consumer model to follow: `packages/orchestrator/src/services/smee-receiver.ts` — native `fetch` + `text/event-stream`, exponential-backoff reconnect (5 s → 300 s cap), payload envelope `{ "x-github-event": <event>, "body": <payload> }`.
- Real-time-first / poll-as-safety-net pattern to mirror: `packages/orchestrator/src/server.ts:470-473` (`config.smee.channelUrl` → disable adaptive polling + use `fallbackPollIntervalMs`).
- Doorbell contract stays: **one stdout line per transition, doorbell only**. Typed data continues to flow through `cockpit_await_events` (the sensor/actuator split from #420 must be preserved — do not make `cockpit_await_events` blocking; that was the #406 regression).

## User Stories

### US1 — Near-instant wake on smee-live clusters (primary)

**As an** operator agent running `/cockpit:auto` against an epic on a smee-live cluster,
**I want** the doorbell to emit its wake line within a few seconds of a relevant GitHub transition,
**So that** the auto loop reacts in near real time instead of waiting up to a full 30 s poll cycle.

**Acceptance criteria**:
- [ ] On a smee-live cluster, p95 latency from a `waiting-for:*` / `completed:*` label change to the doorbell emitting its stdout line is ≤ 3 s (currently ~25 s).
- [ ] The stdout line format is unchanged from #970's shipped doorbell (`<event-type>\n`); consumers do not need to re-parse.
- [ ] Doorbell continues to preserve the sensor/actuator split — typed event data still flows via `cockpit_await_events`, not via the doorbell process.

### US2 — Silent, correct fallback on smee-less clusters

**As an** operator agent running `/cockpit:auto` against an epic on a cluster with no reachable smee channel (freshly-provisioned cluster before #972 lands, or `SmeeChannelResolver` returned null),
**I want** the doorbell to transparently fall back to the shared event-bus poll loop with no behavior change from today,
**So that** the doorbell keeps working during the #972 rollout and on offline / restricted-egress clusters.

**Acceptance criteria**:
- [ ] With no smee channel file present (or file unreadable / malformed), the doorbell falls back to the current `acquireEpicBus` + `subscribeAndEmit` path.
- [ ] Fallback preserves #970's poll-cost reductions (shared bus refcount, TTL eviction, LRU cap, catch-up-on-resume, resolveEpic every-Nth-cycle).
- [ ] Fallback selection is logged once at startup (source: `smee` | `poll-fallback`) with a stable, greppable line for support diagnosis.

### US3 — Resilience to smee disconnects

**As an** operator agent whose smee SSE connection drops mid-run (smee.io is a best-effort free relay),
**I want** the doorbell to reconnect and keep emitting without leaving the auto loop wedged,
**So that** a transient network blip does not stall `/cockpit:auto`.

**Acceptance criteria**:
- [ ] On SSE disconnect the doorbell reconnects with exponential backoff modeled on `SmeeWebhookReceiver` (5 s → 300 s cap; reset on successful connect).
- [ ] Gaps during reconnect are covered by the auto skill's `ScheduleWakeup` heartbeat — doorbell is best-effort, not lossless.
- [ ] Process exit conditions (SIGINT / SIGTERM / `abortSignal` / `exit-on-epic-complete`) remain identical to today's doorbell.

## Functional Requirements

| ID     | Requirement | Priority | Notes |
|--------|-------------|----------|-------|
| FR-001 | Doorbell attempts smee-source first: read `/var/lib/generacy/smee-channel` (path from `GENERACY_SMEE_CHANNEL_FILE_PATH` when set), validate against `SMEE_URL_PATTERN`, and open an SSE connection to the channel URL. | P1 | Source of truth for path is `SmeeChannelResolver`. |
| FR-002 | Doorbell fails **closed to poll fallback** — never fails loud — when: channel file is absent, unreadable, malformed, SSE connect fails, or SSE errors before first event. | P1 | Matches orchestrator's degrade-to-poll posture (`smee-channel-resolver.ts` "return null"). |
| FR-003 | SSE payload filter: emit doorbell lines only for events whose resolved GitHub ref (repo + issue/PR number) belongs to the epic's ref set (epic + children + tracking issue). Non-matching payloads are silently dropped. | P1 | Ref set derivable from `resolveEpic(...)`; reuse the same `parsed.allRefs` the poll cycle uses. |
| FR-004 | SSE ingestion handles at minimum `x-github-event ∈ { issues, pull_request, check_run, check_suite }`. Handler maps each to a `CockpitStreamEvent` type shape compatible with the existing `lineForEvent` output (`<type>\n`). | P1 | Widens beyond today's `action=labeled` filter in the orchestrator's own `SmeeWebhookReceiver`; the doorbell needs pause + resume + PR + check transitions. |
| FR-005 | SSE reconnect uses exponential backoff (base 5 s, cap 300 s, reset on successful connect) modeled on `SmeeWebhookReceiver.calculateBackoffDelay`. | P1 | Direct port. |
| FR-006 | On smee-mode entry the doorbell emits a **one-time startup log line** (stderr) `cockpit doorbell: source=smee channelUrl=<url>` (URL for support diagnosis; not secret — smee URLs are public). On fallback: `cockpit doorbell: source=poll-fallback reason=<code>`. | P2 | Greppable in operator container logs. |
| FR-007 | When smee-mode is active the doorbell does **not** acquire the shared `acquireEpicBus` (no second poller). When it falls back it acquires the bus exactly as today. | P1 | Preserves #970 dual-poll collapse; smee-mode must not resurrect it. |
| FR-008 | Doorbell process lifecycle (SIGINT/SIGTERM, `--exit-on-epic-complete`, `--tracking`, `--new` armed placeholder) is unchanged from today's `runDoorbell`. | P1 | Contract for agency#431 stays stable. |
| FR-009 | The FR-006 capability probe used by agency#431 (skill-side gate on the engine version) continues to gate correctly — the doorbell CLI surface, exit codes, and stdout wake-line format are the version signal. | P1 | Do not rev the CLI shape without updating the probe. |
| FR-010 | No regression to #970's poll-cost reductions (adaptive interval, LRU eviction, TTL, catch-up-on-resume, every-Nth resolveEpic) — the fallback path inherits them unchanged. | P1 | Regression signal: `pnpm --filter @generacy-ai/generacy test cockpit/mcp/event-bus-registry`. |
| FR-011 | Smee-mode ingestion is best-effort: gaps during reconnect are not backfilled from GitHub. The auto skill's `ScheduleWakeup` heartbeat is the safety net for missed wakes. | P2 | Explicit non-guarantee; documented in the doorbell contract. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | p95 wake latency, smee-live cluster (label transition applied → doorbell stdout line flushed). | ≤ 3 s (was ~25 s). | Instrumented test on a smee-provisioned cluster: apply `waiting-for:clarification` via `gh`, measure wall-clock to first doorbell line. |
| SC-002 | Zero-regression on smee-less clusters (no smee channel file). | Doorbell falls back with identical stdout output and identical GitHub API call volume as today's #970 doorbell. | Vitest: mock channel-file-missing; assert `acquireEpicBus` still called with today's args; snapshot stdout lines vs. #970 baseline. |
| SC-003 | No second poll loop when smee is active. | Zero calls to `runOnePoll` / `resolveEpic` originating from the doorbell process on a smee-live run. | Vitest with a spy on `runOnePoll` and `resolveEpic`; assert `.mock.calls.length === 0` after N synthetic smee events. |
| SC-004 | SSE reconnect resilience. | Doorbell recovers within ≤ 10 s after a forced smee disconnect and continues emitting. | Vitest with mock SSE server that closes the stream; assert reconnect + subsequent event emission. |
| SC-005 | agency#431 capability probe still gates correctly. | Probe result matches expectation on old-engine and new-engine builds. | Skill-side test in agency#431 CI; verified on both branches. |

## Assumptions

1. `SmeeChannelResolver` continues to persist the URL to `/var/lib/generacy/smee-channel` (or the env-overridable path). If that changes, doorbell discovery must be updated in lockstep — treat this file as the shared contract.
2. The persisted-channel file is **readable from the operator container** where `generacy cockpit doorbell` runs. If it is not (mount / uid gap), the doorbell falls back to poll and this feature ships a follow-up to expose the URL through a supported operator-container path.
3. On a smee-live cluster where **#972 has landed**, the smee channel actually receives GitHub events. Until #972 lands the channel is empty and the doorbell correctly falls back to polling (SC-001 becomes unmeasurable there — measured against a snappoll-successor cluster or an integration test that injects synthetic smee payloads).
4. `cockpit_await_events` remains the sole typed-data path. The doorbell continues to be a wake-only signal; consumers never parse doorbell stdout as data.
5. Smee URLs are treated as public (they are — anyone can subscribe). The FR-006 startup log line prints the URL for support diagnosis.

## Out of Scope

1. Fixing / replacing the orchestrator's SSE at `orchestrator:3100/events` as an alternative doorbell source. Investigation on #970 confirmed it lacks GitHub-transition publishers, check-run ingestion, and an operator-readable auth path. Long-term option only.
2. Extending `SmeeWebhookReceiver` (the orchestrator's own consumer) beyond `action=labeled`. This spec touches only the cockpit-side consumer; the orchestrator receiver's scope is #972 P2 and separate follow-ups.
3. Registering the GitHub repo webhook (`admin:repo_hook` grant) — that is **#972**'s scope. This feature only consumes what #972 makes available.
4. The skill-side change in agency#431 — no changes needed there; it already spawns `generacy cockpit doorbell` under Monitor and stays passive.
5. Removing the shared event-bus poll loop from the codebase. It stays as the fallback path per FR-002 / FR-010.
6. Changing the doorbell's stdout line format or CLI surface. Any change here would rev the agency#431 capability probe and is a separate coordinated change.

## Dependencies

- **Depends on**: #972 (repo webhook registration — Layer-0 unlock for smee stream to actually carry events).
- **Parent**: #970 (shipped the poll-cost reductions + poll-loop-backed doorbell / original FR-011). This feature implements the revised FR-011 posted after implementation.
- **Consumer**: agency#431 (skill-side — no changes required; FR-006 capability probe continues to gate).

---

*Generated by speckit; enhanced from #978.*
