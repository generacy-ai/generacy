# Feature Specification: cockpit watch phase-complete / epic-complete synthetic events

**Branch**: `885-part-auto-mode-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Part of auto mode (v1.5) — plan: tetrad-development `docs/epic-cockpit-plan.md` §Auto mode. Per "plugin narrates, engine decides," phase/epic aggregation belongs in the engine (`cockpit watch`), not the playbook.

`cockpit watch` gains two synthetic NDJSON events derived from the snapshot diff it already computes: `phase-complete` when the last open issue in a phase transitions to closed, and `epic-complete` when every phase is complete. A new `--exit-on-epic-complete` flag turns the terminal event into a clean exit-0 termination edge for auto mode to consume.

## Behavior

`cockpit watch` derives two synthetic NDJSON events from the snapshot diff it already computes:

- `{"type":"phase-complete","phase":"<heading>", …}` — when the last open issue in a phase transitions to closed (state-dominates-labels semantics per #873; `not_planned` closures count as done for aggregation). Fires once per *transition into* the state; if an issue reopens (phase regresses) and later re-completes, it fires again.
- `{"type":"epic-complete", …}` — when every phase is complete. With `--exit-on-epic-complete`, watch emits it and exits 0 (gives auto mode its termination edge; default behavior unchanged).

Issues in the `(no phase)` group are excluded from any `phase-complete` but included in `epic-complete`.

Startup sweep: if a phase is already complete at watch start, emit the event with `initial: true` (consumers are idempotent — the suggested action, queueing the next phase, is state-checked anyway).

Assist rendering: suggestion lines, e.g. `all P1 — Foundation issues closed — suggested: /cockpit:queue <epic-ref> "P2 — Core functionality"`; `epic complete 🎉` for the terminal event.

Contract documented in the package README (auto mode consumes it there, per the self-contained-commands principle).

## Tests

- Last-merge-in-phase fires `phase-complete` exactly once; a mid-phase merge fires nothing.
- Reopen → regress → re-complete fires twice.
- No-phase issues excluded from `phase-complete`, included in `epic-complete`.
- `--exit-on-epic-complete` exits 0 after emitting the event; without the flag, watch keeps polling.
- Startup sweep emits `initial: true` for pre-completed phases.


## User Stories

### US1: Auto mode has a clean termination edge

**As** the auto-mode driver (planned successor to the cockpit playbook per the epic-cockpit-plan),
**I want** `cockpit watch --exit-on-epic-complete` to emit exactly one terminal `epic-complete` NDJSON event and exit 0 when every phase of the epic is closed,
**So that** I can wrap the watch process in a supervisor loop that terminates cleanly on epic completion rather than polling GitHub state myself or parsing per-issue events.

**Acceptance Criteria**:
- [ ] Exit code is 0 immediately after the `epic-complete` NDJSON line is flushed to stdout.
- [ ] Without `--exit-on-epic-complete`, the process keeps polling (event fires but no exit).
- [ ] The terminal event is emitted at most once per watch process lifetime.

### US2: Phase transitions drive automated queue actions

**As** an operator (or the auto-mode driver) watching a multi-phase epic,
**I want** a `phase-complete` NDJSON event when the last open issue in a phase transitions to closed,
**So that** I can wire "queue the next phase" as a state-checked reaction to a single event edge instead of re-scanning every polled snapshot.

**Acceptance Criteria**:
- [ ] The last closing issue in a phase fires exactly one `phase-complete` event with the phase heading in the `phase` field.
- [ ] A mid-phase closure (issues still open in the phase) fires no `phase-complete`.
- [ ] `not_planned` closures count as complete for aggregation (state-dominates-labels per #873).
- [ ] A phase regression (reopen → the phase is incomplete again → re-complete) fires the event a second time.
- [ ] Issues in the `(no phase)` group never trigger a `phase-complete`, but their closure state does count toward `epic-complete`.

### US3: Startup sweep surfaces already-complete phases

**As** an operator running `cockpit watch` against an epic that already has one or more complete phases,
**I want** those pre-completed phases to emit `phase-complete` events at watch startup with `initial: true`,
**So that** downstream consumers see a consistent event log regardless of when the watch process started, and any suggested action (e.g., queueing the next phase) can idempotently re-fire.

**Acceptance Criteria**:
- [ ] Each phase that is already complete at watch start emits a `phase-complete` event with `"initial": true`.
- [ ] If the epic is already fully complete at watch start, `epic-complete` fires with `"initial": true` (and `--exit-on-epic-complete` still exits 0 after emitting).
- [ ] Transitions after startup emit events without `initial: true` (i.e., `initial` is absent or `false`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit watch` MUST emit a `{"type":"phase-complete","phase":"<heading>", …}` NDJSON event when the last open issue in a phase transitions to closed. | P1 | Fires from the engine's snapshot diff, not the playbook. |
| FR-002 | Phase completion aggregation MUST use state-dominates-labels semantics per #873: an issue's `state` (open/closed) is authoritative; `not_planned` closures count as done. | P1 | Consistent with the state model established in #873. |
| FR-003 | The `phase-complete` event MUST fire once per *transition into* the complete state. A regression (any issue in the phase reopens) followed by a re-completion MUST fire the event again. | P1 | Idempotent consumers still safe; the second fire is a real state change. |
| FR-004 | Issues in the `(no phase)` group MUST be excluded from any `phase-complete` event but MUST be included when computing `epic-complete`. | P1 | Matches the current `(no phase)` grouping semantics in watch. |
| FR-005 | `cockpit watch` MUST emit an `{"type":"epic-complete", …}` NDJSON event when every phase (including the `(no phase)` group) has all issues in a closed state. | P1 | Terminal edge for auto mode. |
| FR-006 | A new `--exit-on-epic-complete` flag MUST cause `watch` to exit with code 0 immediately after the `epic-complete` event line is flushed. Without the flag, watch keeps polling and default behavior is unchanged. | P1 | Opt-in termination edge; back-compat by default. |
| FR-007 | At watch startup, any phase already complete MUST emit `phase-complete` with `"initial": true`. If the epic is already complete, `epic-complete` MUST emit with `"initial": true`. | P1 | Startup sweep. Consumers are idempotent (state-checked action). |
| FR-008 | Post-startup transitions MUST NOT set `initial: true` (field absent or `false`). | P2 | Distinguishes startup replay from live transition. |
| FR-009 | The `phase-complete` and `epic-complete` event contracts (field names, semantics, ordering) MUST be documented in the `@generacy-ai/generacy` package README, since auto mode consumes them there per the self-contained-commands principle. | P1 | Docs land in same PR. |
| FR-010 | Both new events MUST be derived from the snapshot diff `watch` already computes — no additional GitHub API calls in the hot path. | P1 | Engine reuses existing per-poll snapshot; performance parity. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Last-in-phase closure fires `phase-complete` exactly once | 1 event per phase per transition | Test: with N-1 issues in a phase closed and one open, transition the last to closed; assert exactly one `phase-complete` NDJSON line with matching `phase`. |
| SC-002 | Mid-phase closures fire no `phase-complete` | 0 events | Test: close any non-last issue in a phase; assert no `phase-complete` NDJSON line for that phase. |
| SC-003 | Regression + re-completion fires `phase-complete` twice | 2 events | Test: complete phase (1 event), reopen one issue, re-close it; assert a second `phase-complete` NDJSON line for the same phase. |
| SC-004 | `(no phase)` issues excluded from `phase-complete`, included in `epic-complete` | 0 phase-complete for `(no phase)`, 1 epic-complete only when they too are closed | Test: seed an epic with a `(no phase)` open issue and all phases complete; assert no `epic-complete` until the `(no phase)` issue closes. |
| SC-005 | `--exit-on-epic-complete` exits 0 after emitting the event | Exit code 0 within one poll cycle | Test: run watch with the flag, complete the last phase; assert `epic-complete` is the final NDJSON line and the process exits 0. |
| SC-006 | Without `--exit-on-epic-complete`, watch keeps polling after emit | Process still running after event | Test: run watch without the flag, complete the last phase; assert `epic-complete` is emitted and the process is still running one poll cycle later. |
| SC-007 | Startup sweep emits `initial: true` for pre-completed phases | 1 event per pre-completed phase, `initial: true` | Test: start watch against an epic with a phase already complete; assert the phase's `phase-complete` NDJSON line has `"initial": true`. |
| SC-008 | Contract documented in the package README | README section exists and matches the emitted schema | Doc-audit test / review checklist: README contains a section defining `phase-complete` and `epic-complete` event shapes and semantics. |

## Assumptions

- `cockpit watch` already computes a per-poll snapshot of the epic's issues, grouped by phase heading, with each issue's open/closed state — the new events are derived from diffing consecutive snapshots (or the first snapshot vs. an empty prior for the startup sweep).
- State-dominates-labels semantics from #873 are already applied in the snapshot layer; this PR reads the resulting per-issue state without re-implementing the rule.
- The `(no phase)` grouping is a stable concept in the snapshot layer today; no restructuring needed to distinguish "phase" issues from "no phase" issues for `phase-complete` filtering.
- NDJSON stdout is the existing output shape for `watch`; the new event types are additive lines and do not change any existing event schemas.
- Consumers of `phase-complete` (e.g., auto mode) treat the event as an idempotent trigger — they check queue/gate state before acting, so the startup-sweep `initial: true` replay is safe by design.

## Out of Scope

- The auto-mode driver itself (planned successor to the cockpit playbook) — this PR ships only the engine-side events it consumes.
- Any change to per-issue `watch` events (label transitions, gate transitions, PR merges) — those remain unchanged.
- Any change to the snapshot layer or the state-dominates-labels rule (#873) — this PR reads what the snapshot layer already produces.
- Any change to `cockpit:queue`, `cockpit:status`, or other cockpit verbs — this is a `watch`-only change.
- Backfilling historical epic events for existing watch consumers — the startup sweep handles the "started mid-epic" case; nothing writes to persistent history.

---

*Generated by speckit*
