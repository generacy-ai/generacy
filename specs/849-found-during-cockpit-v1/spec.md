# Feature Specification: Pair resume-event dedupe with pause lifecycle so same-gate re-visits are not stranded

**Branch**: `849-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Issue**: [generacy-ai/generacy#849](https://github.com/generacy-ai/generacy/issues/849)

## Summary

Orchestrator's `PhaseTrackerService` dedupes `resume:<gate>` events by writing a Redis key with a long TTL (24h in code; ~12h observed live). The key is written when a resume is enqueued and is checked before the next resume for the same `(owner, repo, issue, gate)` triple. If an issue legitimately re-enters the same gate within the TTL window (a **by-design same-gate re-visit**), the dedupe key from the previous cycle is still present, so the resume event is silently dropped and the workflow strands.

The highest-blast-radius manifestation is the PR-feedback loop: an operator requests changes on an implementation PR, the agent pauses at `waiting-for:address-pr-feedback`, resumes, fixes, pauses again at `waiting-for:implementation-review`, the operator approves — and the resume is deduped by the key written during the FIRST implementation-review. Every re-review within 12h of the first review hits this. Requeued issues re-visiting any gate (the case observed live, christrudelpw/sniplink#2) hit the same failure.

**Fix.** Pair the dedupe with the pause lifecycle instead of relying on time alone. When the worker applies a `waiting-for:<gate>` label (a *new* pause at that gate), delete the corresponding `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` key. Pause and resume are paired events; a fresh pause invalidates the previous resume's dedupe by definition. TTL stays as a backstop only.

**Manual repair** performed on the affected test project (must not be needed after this fix):
`redis-cli DEL phase-tracker:christrudelpw:sniplink:2:resume:implementation-review`

## Grounding

- Dedupe implementation: `packages/orchestrator/src/services/phase-tracker-service.ts` — `PhaseTrackerService.markProcessed()` / `tryMarkProcessed()` write `phase-tracker:<owner>:<repo>:<issue>:<phase>` with `EX = ttlSeconds` (default 86400 = 24h); `clear()` deletes a key; `isDuplicate()` reads existence.
- Pause site (where the fix lands): `packages/orchestrator/src/worker/label-manager.ts` — `LabelManager.onGateHit(phase, gateLabel)` is the sole path that applies `waiting-for:<gate>` on the issue. Dedupe key for `resume:<gate>` is not currently cleared here.
- Resume detection & existing partial pattern: `packages/orchestrator/src/services/label-monitor-service.ts:273-282` already clears the dedupe key for `type === 'process'` events before the check. The `resume` branch does not, which is exactly the gap this feature closes — but from the *pause* side (per the issue's fix direction), not the *resume-check* side.

## User Stories

### US1: Operator re-reviews an implementation PR after request-changes

**As** an operator reviewing an implementation PR,
**I want** to request changes, let the agent address them, and approve the next revision,
**So that** the workflow resumes on my second approval instead of stranding silently.

**Acceptance Criteria**:
- [ ] Request-changes at `implementation-review` → agent pauses at `waiting-for:address-pr-feedback`, then resumes, fixes, pushes.
- [ ] Agent pauses again at `waiting-for:implementation-review`.
- [ ] Operator approves; the resume event is enqueued and processed on the next monitor poll (no "Duplicate event detected" log for the resume key).
- [ ] Behavior holds for a re-review that lands within 24h of the first review (i.e., inside the TTL window).

### US2: Requeued issue re-visits a gate it already cleared once

**As** an operator requeueing an issue that previously advanced past a gate,
**I want** the second visit to that gate to pause, then resume normally,
**So that** requeueing does not silently strand the workflow.

**Acceptance Criteria**:
- [ ] Issue re-enters phase X, pauses at `waiting-for:X-review`.
- [ ] Approval enqueues a resume event even though the same `resume:X-review` key existed from the earlier cycle.
- [ ] No manual `redis-cli DEL …` is required.

### US3: Operator observes normal single-cycle dedupe still works

**As** an operator using the workflow normally,
**I want** duplicate resume events (double-click, retry, webhook redelivery) to remain deduped within a single pause→resume cycle,
**So that** the fix does not regress the original dedupe protection.

**Acceptance Criteria**:
- [ ] Within one pause→resume cycle, a second resume trigger for the same `(issue, gate)` is deduped and does not enqueue.
- [ ] TTL backstop still fires if a resume is somehow written but no fresh pause ever occurs.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | When the worker applies `waiting-for:<gate>` on an issue as part of a *new* pause, the orchestrator MUST delete the `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` key. | P1 | Pause-side clear. Anchor for the whole fix. |
| FR-002 | The dedupe-clear MUST happen at every `LabelManager.onGateHit()` invocation, not only the first time the gate is hit. | P1 | Otherwise the second pause-in-same-cycle still strands the resume. |
| FR-003 | If the Redis `DEL` fails (transient error, Redis down), the pause MUST still succeed — the failure is logged at `warn` and swallowed. | P1 | Matches existing `PhaseTrackerService.clear()` behavior; pause labels are the source of truth. |
| FR-004 | The dedupe-clear MUST scope to only the `resume:<gate>` key for the specific gate being applied, not other dedupe keys for the same issue. | P1 | Do not blow away `process:*` or other gates' resume keys. |
| FR-005 | Existing behavior for `process:*` events (clear stale key before check, at `label-monitor-service.ts:273-282`) MUST remain unchanged. | P2 | Two independent clear sites, both correct. |
| FR-006 | The TTL backstop (default 24h) MUST remain in place unchanged as a safety net for pause events that never fire. | P2 | Keeps protection if pause path is bypassed by a bug. |
| FR-007 | Regression test MUST cover: pause → resume → pause again → resume again, asserting the second resume enqueues (not deduped). | P1 | The exact scenario from the issue's fix description. |
| FR-008 | Regression test MUST cover: pause → resume → immediate duplicate resume, asserting the duplicate resume is still deduped (single-cycle protection intact). | P1 | Non-regression of the original dedupe purpose. |
| FR-009 | The paired DEL MUST run AFTER `addLabels(waiting-for:<gate>)` returns success; if the retried `addLabels` throws, the DEL MUST NOT run (dedupe survives until TTL for that pause only). | P1 | Q1 answer — asymmetric failure: never clear a dedupe for a pause that didn't manifest on the issue. |
| FR-010 | The paired DEL MUST be one-shot (single `phaseTracker.clear(...)` call, no inline retry); transient Redis errors are logged at `warn` and swallowed (FR-003). | P1 | Q2 answer — TTL backstop absorbs the blip; retrying would couple pause success to Redis health. |
| FR-011 | On successful paired-clear, the orchestrator MUST emit an `info` log line identifying the paired-clear (e.g., "Cleared paired resume dedupe on pause") with `phase`, `gateLabel`, `owner`, `repo`, `issueNumber`. On swallowed DEL failure, the log MUST be `warn` with the same structured fields plus the error. | P2 | Q4 answer — makes SC-002 verifiable by log grep instead of runbook grep. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PR-feedback re-review loop completes end-to-end within TTL window | 100% of re-reviews within 24h of the first review resume on operator approval | Integration test simulating request-changes → fix → approve, asserting resume enqueued. |
| SC-002 | Manual `redis-cli DEL phase-tracker:…:resume:…` operator interventions after this fix | 0 | Post-deploy: search operator runbooks and support logs for the `redis-cli DEL phase-tracker:` command being invoked against stranded issues. |
| SC-003 | Single-cycle duplicate resume events remain deduped | 100% of duplicate resume events (same key, same cycle) skip queue enqueue | Unit test on `PhaseTrackerService.isDuplicate()` behavior after `markProcessed` within one cycle. |
| SC-004 | Pause path never blocks on Redis errors | 100% of `onGateHit()` calls complete label application even when Redis is unavailable | Unit test with mocked Redis throwing on `DEL`; assert pause labels still applied. |

## Assumptions

- The dedupe key layout is stable: `phase-tracker:<owner>:<repo>:<issue>:<phase>` where `<phase>` for resume events is `resume:<gate>`. Both are defined in `PhaseTrackerService.buildKey()` and `LabelMonitorService` respectively.
- The pause site is unique: `LabelManager.onGateHit()` is the sole path that applies `waiting-for:<gate>`. If a new pause path is introduced later, it must also clear the paired dedupe key (test guard needed).
- The TTL discrepancy between code (24h) and live observation (~12h) is not load-bearing for the fix — the fix is time-independent. The observed 33255s remaining is consistent with a key ~2.6h into a 24h TTL, not a 12h TTL.
- Redis is available in the normal case; graceful degradation on failure is acceptable and matches existing patterns in `PhaseTrackerService`.

## Out of Scope

- Changing the default TTL value (86400s / 24h). The TTL remains a backstop; adjusting it does not fix the paired-lifecycle bug.
- Rewiring the dedupe key layout or moving from Redis to another store.
- Fixing the `type === 'process'` clear pattern at `label-monitor-service.ts:273-282` (already correct; only the resume side needs the paired clear).
- Retroactively repairing production/test-project stranded issues. Operators use the documented `redis-cli DEL` repair until each stranded issue is unblocked; new pauses after the fix will not accumulate this state.
- UI/cockpit surfacing of "stranded resume" as a distinct diagnostic state.
- Wiring choice for the DEL capability (narrow callback vs. injected service vs. caller-side DEL) is a plan-phase implementation decision, not a spec requirement (Q3 answer favors a narrow callback but does not constrain it here).

---

*Generated by speckit*
