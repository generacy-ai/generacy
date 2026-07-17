# Feature Specification: `generacy cockpit doorbell` verb

**Branch**: `974-summary-cockpit-auto-skill` | **Date**: 2026-07-17 | **Status**: Draft
**Issue**: [generacy#974](https://github.com/generacy-ai/generacy/issues/974)

## Summary

The `/cockpit:auto` skill (agency `claude-plugin-cockpit`) hard-requires a
`generacy cockpit doorbell <epic-ref>` CLI verb as its background wake-sensor,
but that verb was never implemented in generacy. Auto runs on preview clusters
fail to spawn the sensor with `error: unknown command 'doorbell'` and silently
degrade to heartbeat-only (5-min) polling.

This spec adds the missing verb. The verb attaches to the same event-bus poll
loop that `cockpit_await_events` already drains (via `acquireEpicBus` in
`packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`), so it
does **not** start a second poll loop — that is the whole point of #970's
"collapse the dual poll" item. Callers (the skill) treat any non-empty stdout
line as a wake signal; the content is not parsed.

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
      probe passes) and runs until SIGTERM otherwise.
- [ ] Every transition emitted by the shared event-bus produces exactly one
      newline-terminated stdout line.
- [ ] The verb accepts an epic ref positionally, plus `--tracking <ref>` for
      tracking-ref mode and `--new` for epic-less mode, matching how
      `auto.md:53` arms it.
- [ ] The doorbell shares the same event-bus subscription as
      `cockpit_await_events` for the same epic — no second poll loop is
      created; verified via `acquireEpicBus` refcount (>= 2 with both attached).

### US2: Skill can drop the redundant `cockpit watch` subprocess

**As** the maintainer of agency#431,
**I want** the engine-side doorbell to be present,
**So that** the skill can replace the current dual poller (a
`generacy cockpit watch` subprocess PLUS the MCP `cockpit_await_events`
subscriber) with a single subscriber — cutting steady-state GraphQL call rate
against GitHub in half on epics under auto-drive.

**Acceptance Criteria**:
- [ ] With two doorbells attached to the same epic-ref, the underlying poll
      cadence is identical to one — no per-caller multiplier.
- [ ] Releasing the doorbell (SIGTERM) does not tear down the bus if
      `cockpit_await_events` still holds a ref (existing idle-TTL semantics
      preserved).

## Functional Requirements

| ID     | Requirement | Priority | Notes |
|--------|-------------|----------|-------|
| FR-001 | Register `doorbell` subcommand under `cockpit` group in `packages/generacy/src/cli/commands/cockpit/index.ts`. | P1 | So `--help` lists it and Commander routes to the handler. |
| FR-002 | Accept `<epic-ref>` positional argument. Reject empty/missing argument with the same error shape used by `cockpit watch` (`cockpit doorbell: parse issue: issue argument is required`, exit 2). | P1 | Ref grammar identical to `resolveIssueContext` (see #822/#850). |
| FR-003 | Accept `--tracking <ref>` and `--new` flags matching the skill's arming shape (`auto.md:53`). | P1 | `--tracking` and `--new` are mutually exclusive with each other; `<epic-ref>` positional stays required unless `--new` is passed. |
| FR-004 | Attach to the shared `EpicEventBus` for the resolved ref via `acquireEpicBus()` — do NOT construct a second poll loop. | P1 | This is the poll-collapse contract. |
| FR-005 | Subscribe to the bus and emit **one newline-terminated stdout line per event received**. | P1 | Content is not a documented contract with the caller; a single-word marker (e.g. the event `type`) is sufficient. |
| FR-006 | Flush stdout after each write (do NOT rely on Node's block-buffered default when stdout is not a TTY). | P1 | Skill reads line-by-line; buffered writes defeat the wake signal. |
| FR-007 | On SIGTERM / SIGINT, unsubscribe from the bus, call the `release()` returned by `acquireEpicBus`, and exit 0. | P1 | Preserves refcount semantics; other bus users unaffected. |
| FR-008 | On `--help` the verb prints usage and exits 0 (satisfies the skill's `--help` pre-flight probe). | P1 | Commander default behavior — nothing extra required. |
| FR-009 | Log warnings (poll errors, resolve failures) to stderr, not stdout. | P1 | stdout is reserved for wake signals only. |
| FR-010 | Emit an **initial** doorbell line once the initial poll completes, so the skill can observe that the sensor is armed and steady. | P2 | Distinguishes "sensor up, epic quiet" from "sensor never started". |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | `generacy cockpit doorbell --help` exits 0 on a fresh preview cluster. | Exit code 0. | Manual: run against the next preview build. |
| SC-002 | On an epic with concurrent `cockpit_await_events` subscriber and `doorbell` process, the underlying `EpicEventBus` refcount is >= 2, and only ONE poll loop is running. | Refcount == 2; poll cadence == default (30s). | Integration test using `acquireEpicBus` from `event-bus-registry.ts` directly. |
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
  server context). If it is not — e.g., it relies on a running MCP server for
  bus lifecycle — the implementation may extract the shared poll driver into a
  reusable module. This is a planning-phase decision.
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
- Documented stdout payload format for the doorbell. Only "non-empty line per
  event" is contracted.

---

*Generated by speckit, filled in from generacy#974.*
