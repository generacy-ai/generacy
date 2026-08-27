# Feature Specification: Dependency-Blocked Implement Pause

**Branch**: `1211-problem-clarify-phase-answer` | **Date**: 2026-08-27 | **Status**: Draft  
**Issue**: [generacy-ai/generacy#1211](https://github.com/generacy-ai/generacy/issues/1211)  
**Workflow**: `workflow:speckit-bugfix`

## Summary

Wire the existing `waiting-for:dependencies` label so the implement phase can emit a structured "blocked on `<ref>`" sentinel. The engine applies the gate as a non-error pause instead of triggering the no-progress guard, and re-arms when the named refs close.

## Problem

A clarify-phase answer of the form *"block on sibling issue #N until it merges"* has no way to express a **wait** to the engine. The implement agent correctly writes no code, `tasks_remaining` doesn't move, and the no-progress guard (`phase-loop.ts:957-987`) converts that correct behaviour into `failed:implement` + `agent:error`.

The `waiting-for:dependencies` label exists (`label-definitions.ts:44`, *"Waiting for blocking issues"*) but **nothing reads or applies it**. A repo-wide grep across `packages/orchestrator/src` and `packages/workflow-engine/src` returns no consumer. It is also absent from `WAITING_PIPELINE_ORDER` in cockpit.

### Evidence (epic #1197, 2026-08-26)

Three of four P1 issues hard-blocked on sibling #1198. All produced the identical failure:

| Issue | Failure |
|---|---|
| #1199 | `no progress: tasks_remaining stayed at 16 across two increments` |
| #1200 | `no progress: tasks_remaining stayed at 13 across two increments` |
| #1201 | `no progress: tasks_remaining stayed at 20 across two increments` |

Each `tasks.md` carried an explicit blocking gate task (e.g. #1199's T001: *"HARD-BLOCK (Q4→A): No implementation code lands until generacy#1198 merges"*).

### Knock-on cost

Each forced requeue re-triggers a rebase onto a `develop` that sibling merges have moved, driving `CLAUDE.md` merge-conflict escalations within the same phase.

## Clarifications

### Session 2026-08-27

- Q1 → **A**: Blocked refs persist in a dedicated marker-stamped comment (`<!-- generacy-dependency-block -->`) with a machine-parseable refs list; newest marker comment wins. Stage comment may additionally mention the block for human readability. (Stage-comment embedding is unsafe — edited in place; Redis is unsafe — dev-cluster Redis has no volume, a `compose down` loses the gate.)
- Q2 → **A**: Commit and push WIP (when there are changes) before applying the gate. `SPECKIT_IMPLEMENT_PARTIAL` and `SPECKIT_IMPLEMENT_BLOCKED` may coexist in the same increment — blocked wins control flow, partial counts are recorded.
- Q3 → **C**: Any closed state re-arms (issues and PRs), but a closed-as-not-planned issue or an unmerged-closed PR is flagged in the re-arm comment so the operator is alerted. Safe only because of the Q4 cap.
- Q4 → **B**: Blocked→resume cycles are capped at a small N; at the cap, escalate to a distinct operator gate instead of re-pausing silently (precedent: `maxRemediations` + `waiting-for:remediation-limit`).
- Q5 → **B**: Transient ref-read errors retry quietly; after 3 consecutive failures on the same ref, surface an operator-visible escalation (comment or distinct label) while keeping the gate held. N=3 suggested; adjust in plan if a better precedent exists.

## User Stories

### US1: Agent signals a deliberate dependency block

**As a** speckit agent in the implement phase,  
**I want** to emit a structured sentinel when the issue is blocked on a sibling dependency,  
**So that** the engine pauses the workflow cleanly instead of escalating it as a failure.

**Acceptance Criteria**:
- [ ] Agent can emit `SPECKIT_IMPLEMENT_BLOCKED: {"on": ["owner/repo#N", ...]}` during implement
- [ ] Engine parses the sentinel from CLI output (alongside the existing `SPECKIT_IMPLEMENT_PARTIAL`)
- [ ] Engine applies `waiting-for:dependencies` + `agent:paused` labels instead of `failed:implement` + `agent:error`
- [ ] The no-progress guard is skipped when the blocked sentinel is present

### US2: Operator sees the dependency block in cockpit

**As a** developer monitoring a speckit workflow,  
**I want** to see `waiting-for:dependencies` surfaced in the cockpit UI alongside other gates,  
**So that** I can tell at a glance which issues are blocked and on what.

**Acceptance Criteria**:
- [ ] `waiting-for:dependencies` appears in `WAITING_PIPELINE_ORDER` in cockpit
- [ ] The blocked refs are visible (marker-stamped comment; stage comment may also mention the block)
- [ ] Cockpit `advance` can clear the gate when the dependency is resolved

### US3: Workflow resumes when dependencies close

**As a** developer,  
**I want** the engine to automatically re-arm a blocked issue when its named dependencies close,  
**So that** I don't have to manually track and resume each blocked issue.

**Acceptance Criteria**:
- [ ] Engine enqueues the blocked issue when all `on` refs are closed
- [ ] Gate is cleared (`waiting-for:dependencies` + `agent:paused` removed)
- [ ] `completed:dependencies` is applied to satisfy the resume label protocol

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | New `SPECKIT_IMPLEMENT_BLOCKED` sentinel parsed in `OutputCapture` alongside `SPECKIT_IMPLEMENT_PARTIAL` | P1 | Format: `SPECKIT_IMPLEMENT_BLOCKED: {"on": ["owner/repo#N", ...]}` |
| FR-002 | `ImplementPartialResult` gains optional `blocked_on?: string[]` field | P1 | Non-empty array of `owner/repo#N` refs |
| FR-003 | No-progress guard in `phase-loop.ts` is skipped when `implementResult.blocked_on` is present | P1 | Before the `tasksRemaining >= lastTasksRemaining` check |
| FR-004 | Engine applies `waiting-for:dependencies` + `agent:paused` via `LabelManager.onGateHit` | P1 | Follows the same pattern as other gates |
| FR-005 | Blocked refs are persisted in a dedicated marker-stamped comment (`<!-- generacy-dependency-block -->`) with a machine-parseable refs list; newest marker comment wins | P1 | Q1=A. The stage comment may additionally mention the block for human readability |
| FR-006 | `waiting-for:dependencies` added to `WAITING_PIPELINE_ORDER` in cockpit | P1 | Ensures the gate surfaces correctly in the UI |
| FR-007 | New dependency monitor (or label-monitor extension) checks closed state of referenced issues | P1 | Reads refs from the marker comment; any closed state re-arms (Q3=C). A not-planned close or unmerged-closed PR is flagged in the re-arm comment |
| FR-008 | Re-arm clears `waiting-for:dependencies` + `agent:paused`, applies `completed:dependencies` | P1 | Follows the existing resume label protocol |
| FR-009 | `completed:dependencies` label definition added to `label-definitions.ts` | P1 | Color `0E8A16` (matches other completed labels) |
| FR-010 | Sentinels are idempotent — last seen wins (same as `SPECKIT_IMPLEMENT_PARTIAL`) | P2 | Multiple sentinels in the same increment = last one used |
| FR-011 | Malformed sentinel JSON is logged and ignored (same as `SPECKIT_IMPLEMENT_PARTIAL`) | P2 | Non-breaking; the implement phase continues normally |
| FR-012 | Engine commits and pushes WIP (when there are changes) before applying the dependency gate; `SPECKIT_IMPLEMENT_PARTIAL` and `SPECKIT_IMPLEMENT_BLOCKED` may coexist — blocked wins control flow, partial counts recorded | P1 | Q2=A. Matches the existing increment commit/push contract (`phase-loop.ts:990`) |
| FR-013 | Blocked→resume cycles on the same issue are capped at a small N; at the cap, escalate to a distinct operator gate instead of re-pausing silently | P1 | Q4=B. Precedent: `maxRemediations` + `waiting-for:remediation-limit` (`phase-loop.ts:1642-1677`). Cap label must join the resume-retain set (`DEFAULT_RESUME_RETAIN_SUFFIXES`) so a resume cannot strip it |
| FR-014 | Monitor retries transient ref-read errors quietly; after 3 consecutive failures on the same ref, surfaces an operator-visible escalation (comment or distinct label) while keeping the gate held | P1 | Q5=B. Never fail-open; never strand silently |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Blocked issues pause cleanly | Zero `failed:implement` escalations from dependency blocks | Observe a blocked issue's labels after implement exits: `waiting-for:dependencies` + `agent:paused` present, no `agent:error` |
| SC-002 | Existing no-progress guard still fires | Non-blocked stalls still produce `failed:implement` | Unit test: implement with no sentinel and no `tasks_remaining` change → guard fires |
| SC-003 | Gate re-arms on dependency close | Blocked issue enqueues within one poll cycle of last ref closing | Integration test: create blocked issue, close the dependency, assert re-enqueue within monitor poll interval |
| SC-004 | Cockpit surfaces the gate | `waiting-for:dependencies` visible in cockpit status | `cockpit status` on a blocked issue shows the gate |

## Assumptions

1. **Sentinel is emitted by the agent, not the engine**. The speckit agent prompt will be updated (in the agency repo) to include the `SPECKIT_IMPLEMENT_BLOCKED` sentinel format. The engine only parses and reacts to it.
2. **Re-arm is poll-based, not webhook-based**. The dependency monitor polls the referenced issues periodically (same cadence as the label monitor). This avoids webhook setup complexity.
3. **Blocked refs are stored in a dedicated marker-stamped comment** (`<!-- generacy-dependency-block -->`), matching every existing machine-read comment contract (`generacy-clarifications:N`, `generacy-cockpit:unanchored-findings`, `generacy-finding:*`, `generacy-ci-pause`). Newest marker comment wins. The stage comment may additionally mention the block for human readability. (Clarified from "stage comment" — Q1=A.)
4. **`waiting-for:dependencies` is treated as a human gate**. The `isHumanGateCompletion` check in `label-manager.ts` already covers it (derived from `GATE_MAPPING`), so `completed:dependencies` survives the resume strip.
5. **Single `completed:dependencies` label** satisfies the resume protocol. The monitor applies it when clearing the gate so the issue's label history is auditable.
6. **The `on` array uses the `owner/repo#N` format** matching the existing issue-ref grammar (`resolver.ts`). Numeric-only refs are resolved against the current repo.

## Out of Scope

- **Prompt changes** — updating the speckit agent prompt to emit the sentinel is in the agency repo, not here
- **Cross-repo dependency resolution** — `on` refs are assumed to be in the same GitHub org; cross-org resolution is a follow-up
- **Transitive dependency chains** — if issue A blocks on B which blocks on C, closing C does not cascade to A
- **`SPECKIT_IMPLEMENT_BLOCKED` in non-implement phases** — the sentinel is only parsed during implement; other phases are unaffected
- **Removing the existing `waiting-for:dependencies` label definition** — it already exists and is correct

## Design Notes

### Sentinel format

```
SPECKIT_IMPLEMENT_BLOCKED: {"on": ["generacy-ai/generacy#1198"]}
```

Multiple dependencies:
```
SPECKIT_IMPLEMENT_BLOCKED: {"on": ["generacy-ai/generacy#1198", "generacy-ai/generacy#1200"]}
```

### Parse site

`OutputCapture.parseLine()` in `packages/orchestrator/src/worker/output-capture.ts`. A new `SENTINEL_BLOCKED_PREFIX = 'SPECKIT_IMPLEMENT_BLOCKED: '` constant is added alongside the existing `SENTINEL_PREFIX`. The parsed payload is stored in `_implementResult.blocked_on`.

### Phase-loop flow

In `phase-loop.ts`, after the implement phase succeeds and before the increment guard:

```
if (result.implementResult?.blocked_on?.length) {
  // Apply dependency gate, skip no-progress guard
  await labelManager.onGateHit('implement', 'waiting-for:dependencies');
  // Post blocked refs in stage comment
  // Return { completed: false, gateHit: true }
}
```

### Re-arm monitor

A new `DependencyMonitorService` (or an extension to `LabelMonitorService`) polls for issues with `waiting-for:dependencies`. For each, it reads the blocked refs from the stage comment, checks each ref's closed state via `gh issue view --json closed`, and when all are closed: clears the gate, applies `completed:dependencies`, and enqueues the issue.

### GATE_MAPPING entry

```typescript
'dependencies': { phase: 'implement', resumeFrom: 'implement' }
```

Resuming from `implement` re-enters the implement phase, which will re-check the dependency and either proceed (if the sentinel is no longer emitted) or re-pause.

---
*Generated by speckit*