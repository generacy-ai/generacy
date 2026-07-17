# Feature Specification: `generacy cockpit doorbell` verb

**Branch**: `974-summary-cockpit-auto-skill` | **Date**: 2026-07-17 | **Status**: Draft
**Issue**: [generacy#974](https://github.com/generacy-ai/generacy/issues/974)

## Summary

The `/cockpit:auto` skill (agency `claude-plugin-cockpit`) hard-requires a
`generacy cockpit doorbell <epic-ref>` CLI verb as its background wake-sensor,
but that verb was never implemented in generacy. Auto runs on preview clusters
fail to spawn the sensor with `error: unknown command 'doorbell'` and silently
degrade to heartbeat-only (5-min) polling.

This spec adds the missing verb. The verb runs as a self-contained CLI process
that constructs its own in-process refcounted `EpicEventBus` (via
`acquireEpicBus` in
`packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`) and
subscribes to it. The cockpit MCP server is stdio-only and cannot be attached
to across processes, so cross-process bus sharing (agency#431's aspirational
"one poll loop per epic") is out of scope for this verb — see
Clarifications Q1. The doorbell replaces the `cockpit watch` subprocess as the
sensor, so net poll-loop count under auto-drive stays at today's baseline
(watch + MCP `cockpit_await_events`) rather than increasing. Callers (the
skill) treat any non-empty stdout line as a wake signal; the content is not
parsed.

## Background — cross-repo drift

The doorbell was the engine half of the cockpit-auto poll-collapse work:

- **agency#431** (skill side) says explicitly: *"Once generacy exposes a single
  shared poll signal (a doorbell emitted by the same event-bus poll loop that
  `cockpit_await_events` drains), drop the separate `generacy cockpit watch`
  subprocess… the doorbell mechanism has to land engine-side first."*
- **generacy#970** (this repo) listed *"have the skill drop the separate
  `cockpit watch` and rely on a doorbell the event bus exposes"* as a proposed
  fix in its spec.

generacy#970 shipped as PR #971 (`55844a07`) — but delivered only the GraphQL
rate-limit efficiency work (rate-limit scheduler, gh response cache,
lifecycle-gated check polling, conditional epic refresh, catch-up double-poll
fix). **The doorbell CLI verb was never built.** The skill (agency#431 /
`auto.md`) shipped assuming it had.

## Evidence

Preview build `@generacy-ai/generacy@0.0.0-preview-20260717045830-01bbb03`:

```
$ generacy cockpit doorbell christrudelpw/snappoll#1
error: unknown command 'doorbell'   # exit 1
```

Registered cockpit subcommands (running container **and** `develop` source —
`packages/generacy/src/cli/commands/cockpit/index.ts`):
`watch, status, advance, context, merge, queue, resume, scope, mcp`. No
`doorbell`.

## User Stories

### US1: Auto driver gets low-latency wakes on epic transitions

**As** the `/cockpit:auto` skill running on an orchestrator container,
**I want** to spawn `generacy cockpit doorbell <epic-ref>` as a background
sensor,
**So that** every observed transition on the epic (or its tracking ref)
produces a non-empty stdout line that the skill treats as a wake signal —
restoring near-instant reaction latency instead of the ~5-min fallback
`ScheduleWakeup` heartbeat.

**Acceptance Criteria**:
- [ ] `generacy cockpit doorbell <epic-ref>` exits 0 on `--help` (pre-flight
      probe passes) and runs until SIGTERM otherwise (default; see FR-011 for
      opt-in `--exit-on-epic-complete`).
- [ ] Every event emitted by the in-process event-bus produces exactly one
      newline-terminated stdout line. The line content is the event `type`
      word (`issue-transition`, `phase-complete`, `epic-complete`); the initial
      FR-010 armed line is the constant `armed`. (Clarifications Q3=B, Q4=A.)
- [ ] The verb accepts an epic ref positionally under Form 1
      (`doorbell <epic-ref>`) and Form 2 (`doorbell <tracking-ref> --tracking`),
      and takes no positional under Form 3 (`doorbell --new "<title>"`),
      matching how `auto.md:53` arms it. (Clarifications Q2=A.)
- [ ] The doorbell's poll loop is refcounted in-process via `acquireEpicBus()`:
      two doorbell subscribers **inside the same process** share one poll
      loop. Cross-process sharing with the MCP server's `cockpit_await_events`
      is explicitly not attempted (Clarifications Q1=C).

### US2: Skill can drop the redundant `cockpit watch` subprocess

**As** the maintainer of agency#431,
**I want** the engine-side doorbell to be present,
**So that** the skill can replace the current `generacy cockpit watch`
subprocess with the doorbell as its stdout wake sensor. Net poll-loop count
under auto-drive is unchanged (doorbell process + MCP `cockpit_await_events`
process — the doorbell simply takes `watch`'s slot). True cross-process
poll-collapse (agency#431's "one poll loop per epic") is a follow-up requiring
a new IPC surface (Clarifications Q1 option B) and is not delivered by this
spec.

**Acceptance Criteria**:
- [ ] With two `acquireEpicBus()` subscribers **inside the doorbell process**
      (e.g., a test that acquires the bus twice), the underlying poll cadence
      is identical to one — no per-caller multiplier.
- [ ] Releasing one subscriber's `release()` inside the doorbell process does
      not tear down the bus if another in-process ref is still held (existing
      idle-TTL / refcount semantics preserved).

## Functional Requirements

| ID     | Requirement | Priority | Notes |
|--------|-------------|----------|-------|
| FR-001 | Register `doorbell` subcommand under `cockpit` group in `packages/generacy/src/cli/commands/cockpit/index.ts`. | P1 | So `--help` lists it and Commander routes to the handler. |
| FR-002 | Accept `<epic-ref>` positional argument. Reject empty/missing argument with the same error shape used by `cockpit watch` (`cockpit doorbell: parse issue: issue argument is required`, exit 2). | P1 | Ref grammar identical to `resolveIssueContext` (see #822/#850). |
| FR-003 | Accept `--tracking` (flag, no value) and `--new "<title>"` flags matching the skill's arming shape (`auto.md:53`). Under Form 1 the positional is the epic ref and subscribes the epic bus. Under Form 2 (`<ref> --tracking`) the positional is the tracking-issue ref and subscribes the tracking-ref bus (same `acquireEpicBus`, different key — `EpicEventBus` keys on any ref `resolveIssueContext` can expand). Under Form 3 (`--new "<title>"`) no positional is accepted and the doorbell emits only the FR-010 `armed` line then blocks on SIGTERM without a subscription. `--tracking` and `--new` are mutually exclusive. (Clarifications Q2=A.) | P1 | Ref grammar identical to `resolveIssueContext` (see #822/#850). |
| FR-004 | Construct and subscribe to an in-process `EpicEventBus` for the resolved ref via `acquireEpicBus()`. The doorbell's "shared" contract is single-process: multiple `acquireEpicBus` calls **inside the doorbell process** share one poll loop; the doorbell does **not** attach to the MCP-server process's bus. (Clarifications Q1=C.) | P1 | The MCP server is stdio-only and cannot accept a second client; cross-process poll-collapse is a follow-up (Q1 option B). |
| FR-005 | Subscribe to the bus and emit **one newline-terminated stdout line per event received**, 1:1 with `bus.emit()`, with no filter (Clarifications Q4=A). Each line contains the event `type` word only (`issue-transition`, `phase-complete`, `epic-complete`) — no JSON, no ref (Clarifications Q3=B). | P1 | The `CockpitStreamEvent` union today is exactly those three types; `epic-refresh` mentioned in the clarification context is not a real emitted type. |
| FR-006 | Flush stdout after each write (do NOT rely on Node's block-buffered default when stdout is not a TTY). | P1 | Skill reads line-by-line; buffered writes defeat the wake signal. |
| FR-007 | On SIGTERM / SIGINT, unsubscribe from the bus, call the `release()` returned by `acquireEpicBus`, and exit 0. | P1 | Preserves in-process refcount semantics; other in-process bus users unaffected. |
| FR-008 | On `--help` the verb prints usage and exits 0 (satisfies the skill's `--help` pre-flight probe). | P1 | Commander default behavior — nothing extra required. |
| FR-009 | Log warnings (poll errors, resolve failures) to stderr, not stdout. | P1 | stdout is reserved for wake signals only. |
| FR-010 | Emit an **initial** out-of-band `armed\n` line once the initial poll completes (or, under Form 3 `--new`, immediately at startup with no subscription), so the skill can observe that the sensor is armed and steady. The `armed` line is emitted directly to stdout, not routed through `bus.emit()` (Clarifications Q4=A rationale). | P2 | Distinguishes "sensor up, epic quiet" from "sensor never started". |
| FR-011 | Accept an optional `--exit-on-epic-complete` flag mirroring `cockpit watch` (`watch.ts:217-225, 253`). Off by default; when on, after emitting the `epic-complete\n` line the doorbell flushes stdout and `process.exit(0)`. When off (the default), the doorbell keeps polling after `epic-complete` and exits only on SIGTERM/SIGINT. Only meaningful under Form 1 (epic-ref); no-op under Form 2/3 where `epic-complete` never fires. (Clarifications Q5=B.) | P2 | Parity with `watch` — skill can opt in to auto-teardown, otherwise harness `Monitor` kills the sensor on epic terminal. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | `generacy cockpit doorbell --help` exits 0 on a fresh preview cluster. | Exit code 0. | Manual: run against the next preview build. |
| SC-002 | Inside the doorbell process, two concurrent `acquireEpicBus()` subscribers on the same ref share ONE poll loop (refcounted). Cross-process sharing with the MCP server is out of scope for this spec (Clarifications Q1=C). | In-process refcount == 2; poll cadence == default (30s); one active poll timer. | Vitest against the doorbell handler and `event-bus-registry.ts`, in-process. |
| SC-003 | Every event emitted by the bus produces exactly one stdout line on the doorbell process. | 1:1 (event to line). | Vitest against the doorbell handler with a stubbed bus. |
| SC-004 | Auto-drive latency from a real epic transition to skill wake drops from the 5-min `ScheduleWakeup` fallback to `<= 60s` (poll cadence + emit). | p95 <= 60s. | Preview-cluster verification during `/cockpit:auto` run on a synthetic epic. |
| SC-005 | Zero regressions in `cockpit watch` / `cockpit_await_events` behavior. | All existing tests pass. | Existing `packages/generacy/src/cli/commands/cockpit/__tests__/` + `mcp/__tests__/` green. |

## Assumptions

- The verb runs on the orchestrator container. Workers can't reach the
  control-plane socket, but the event-bus registry lives inside the
  orchestrator process — this constrains where the skill spawns the sensor
  (already true today for `cockpit watch`).
- The skill (`auto.md`) treats **any** non-empty stdout line as a wake. No
  NDJSON payload contract is required. The verb is free to emit terse markers.
- `acquireEpicBus` is safe to call from a CLI process (not only from the MCP
  server context). This is now a hard requirement, not a planning question,
  under Clarifications Q1=C: the doorbell verb owns its own bus in-process.
  If refactor is needed to make `acquireEpicBus` process-agnostic (e.g.
  extracting the poll driver into a reusable module used by both CLI and MCP
  paths), that lands as part of this feature.
- The `CockpitStreamEvent` union today is exactly `issue-transition` +
  `phase-complete` + `epic-complete` (see `watch/stream-event.ts`). No
  cycle-boundary noise events exist, so FR-005's "all events, no filter"
  contract does not need a noise-list carve-out. If the union grows, the
  filter policy must be re-visited (out of scope for this spec).
- Existing `--tracking` / `--new` handling in the skill matches the parse
  shape used by other epic-taking cockpit verbs (`watch`, `status`).

## Out of Scope

- Any changes to `/cockpit:auto` (`auto.md`) itself. That is
  [agency#431](https://github.com/generacy-ai/agency/issues/431).
- Removing the `generacy cockpit watch` subcommand. It stays for
  human/interactive use even after the skill drops it.
- Hardening the skill's `--help` pre-flight probe to distinguish "verb
  present" from "verb absent" (currently `--help` exits 0 in both cases when
  Commander sees an unknown subcommand under a parent group). That is a
  companion agency-side issue mentioned in #974's Related section.
- Documented stdout payload format for the doorbell as a *caller contract*.
  Content is deterministic for testability (FR-005, Clarifications Q3=B), but
  callers (the skill) continue to treat any non-empty line as a wake and MUST
  NOT parse the content.
- Cross-process poll-loop collapse between the doorbell process and the MCP
  server's `cockpit_await_events`. Achieving agency#431's "one poll loop per
  epic" aspiration requires a new IPC surface (Clarifications Q1 option B) and
  is deferred as a follow-up if the 2× cost proves material.

---

*Generated by speckit, filled in from generacy#974.*
