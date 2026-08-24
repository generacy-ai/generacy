# Feature Specification: Engine-side tasks.md safety net for the implement→continue increment

**Branch**: `1187-summary-implement-continue` | **Date**: 2026-08-24 | **Status**: Draft

## Summary

The implement→continue increment mechanism depends **entirely** on the agent emitting a `SPECKIT_IMPLEMENT_PARTIAL: {...}` sentinel line. When the agent stops mid-tasklist **without** emitting it, the engine treats the partial implement as complete, grants `completed:implement`, and advances to `review` — shipping a substantially unfinished implementation into the review→remediate loop, which is not designed to implement large volumes of net-new tasks and caps.

Make the continuation loop robust to sentinel omission by adding an engine-side fallback: after a "successful" implement phase, parse `tasks.md` for unchecked `- [ ]` tasks and re-enter implement when work remains. The sentinel stays as the fast path; `tasks.md` becomes the source of truth for whether the implement phase is actually complete.

## Evidence (finetooth / Painworth/doc-intel#26, PR #73)

- Implement commit `c3dbdee` checked tasks **T001–T011** in `tasks.md` and built them; left **T012–T026 (15 tasks) unchecked** — including the core deliverable `evals/run.mjs` (T015), the 8 gates, golden, and 4/5 scenario arms.
- Implement transcript's final message: *"Increment complete. I implemented Phases 1–2 (T001–T011)…"* with `stop_reason: end_turn` — a **voluntary** stop (not a usage limit, error, or timeout), but **no `SPECKIT_IMPLEMENT_PARTIAL` sentinel** was emitted.
- Engine granted `completed:implement` and advanced to `review`. Review correctly found the deliverable absent (a true finding). `evals/run.mjs` was first created two phases later in a **remediate** commit (`3144866`).
- The review→remediate loop then had to implement the missing ~15 tasks, burned all 3 remediation rounds, hit `waiting-for:remediation-limit`, and required a manual `completed:remediation-limit` budget grant.

## Root cause

`packages/orchestrator/src/worker/phase-loop.ts:873`:
```ts
if (phase === 'implement' && result.success && result.implementResult?.partial) { ... i--; continue; }
```
`result.implementResult` is populated only by parsing the `SPECKIT_IMPLEMENT_PARTIAL` sentinel (`output-capture.ts`). No sentinel → `implementResult === undefined` → the re-loop is skipped → `result.success === true` → `completed:implement`. The prompt (`agency .../commands/implement.md:210-217`) instructs the agent to emit the sentinel as the final line, but compliance is not guaranteed, and there is **no engine-side fallback** — `end_turn` alone is trusted as "all tasks done".

## Impact

- Partial implementations advance to review whenever the agent forgets the sentinel.
- Net-new implementation is offloaded to review→remediate, which caps (`maxRemediations`) and forces a human `remediation-limit` gate — the exact churn observed on #26.
- `completed:implement` is granted with unchecked tasks in `tasks.md`, so the label misrepresents state.

## User Stories

### US1: Sentinel-omitting partial implement re-enters implement (Primary)

**As a** developer running a speckit-feature or speckit-bugfix workflow,
**I want** the engine to re-enter the implement phase when `tasks.md` still has unchecked tasks, even if the agent forgot to emit the `SPECKIT_IMPLEMENT_PARTIAL` sentinel,
**So that** the full task list is implemented before advancing to review, instead of offloading net-new work onto the review→remediate loop where it caps and stalls.

**Acceptance Criteria**:
- [ ] When an implement phase returns `success` with **no** sentinel but `tasks.md` contains ≥1 unchecked `- [ ]` task, the engine re-enters the implement phase (same path as a sentinel-driven increment: WIP commit/push, fresh session, `i--; continue`).
- [ ] The re-entry respects the existing no-progress guard: if the count of unchecked tasks does not decrease across two increments, the phase fails with the no-progress error rather than looping forever.
- [ ] `tasks_remaining` for the increment log/commit message and the guard is derived from the `tasks.md` unchecked count when the sentinel is absent.

### US2: Honest `completed:implement`

**As a** developer (or the cockpit operator) reading issue labels,
**I want** `completed:implement` to be granted only when `tasks.md` is fully checked (or the story legitimately has no tasks),
**So that** the label accurately reflects implementation state and downstream review is not handed an unfinished tree.

**Acceptance Criteria**:
- [ ] The implement phase advances (granting `completed:implement`) only when `tasks.md` has zero unchecked `- [ ]` tasks, or when no `tasks.md` / no task lines exist.
- [ ] The sentinel remains the fast path: when the agent emits `SPECKIT_IMPLEMENT_PARTIAL`, existing behavior is unchanged.

### US3: Bounded fallback loop

**As a** cluster operator,
**I want** the fallback re-entry to be bounded by the same retry/no-progress controls that govern sentinel-driven increments,
**So that** a stuck agent that never checks off tasks escalates for human attention instead of consuming budget indefinitely.

**Acceptance Criteria**:
- [ ] The fallback path shares the increment's no-progress guard and does not bypass `maxImplementRetries`-style limits.
- [ ] On no-progress abort, the phase escalates/alerts with diagnostic evidence exactly as the sentinel path does today.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After a `success` implement phase with `result.implementResult === undefined`, the engine MUST parse the workflow's `tasks.md` and count unchecked `- [ ]` task lines. | P1 | Feature dir resolved as `specs/{issueNumber}-*` under `context.checkoutPath` (same convention as `epic-post-tasks.ts:293`). |
| FR-002 | If unchecked tasks remain, the engine MUST treat the phase as partial and re-enter implement via the existing increment path (WIP commit/push, clear session, `i--; continue`). | P1 | Reuse the block at `phase-loop.ts:873–937`. |
| FR-003 | The fallback MUST feed `tasks_remaining` = unchecked-task count into the no-progress guard (`lastTasksRemaining` at `phase-loop.ts:877`). | P1 | Prevents infinite loops when the agent makes no progress. |
| FR-004 | `completed:implement` MUST be granted only when `tasks.md` has zero unchecked tasks, or no `tasks.md`/task lines exist. | P1 | Keeps the label honest. |
| FR-005 | The existing sentinel-driven path MUST remain unchanged when the sentinel is present. | P1 | Sentinel is the fast path; tasks.md is the fallback source of truth. |
| FR-006 | When `tasks.md` cannot be located or read, the engine MUST fall back to today's behavior (advance) and log the reason. | P2 | Fail-open to avoid stranding legitimately-complete or task-less stories. |
| FR-007 | Checkbox parsing MUST recognize unchecked (`- [ ]`) vs checked (`- [x]`/`- [X]`) task lines and ignore non-task Markdown. | P1 | Match the `- [ ]` grammar the implement prompt writes. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sentinel-omitted partial implements that re-enter implement | 100% | Given a `success` implement with no sentinel and unchecked `tasks.md`, the engine re-enters implement (asserted in a phase-loop test). |
| SC-002 | Reproduction of the #26 incident is prevented | 0 false completions | With the T001–T011-checked / T012–T026-unchecked fixture and no sentinel, `completed:implement` is NOT granted and implement re-enters. |
| SC-003 | Fully-checked tasks.md advances | 100% | Given a `success` implement with all tasks checked (or no tasks.md), the phase advances exactly as today. |
| SC-004 | No infinite loop on stuck agent | Bounded | Given no decrease in unchecked count across two increments, the phase fails with the no-progress error and escalates. |
| SC-005 | Sentinel fast path unchanged | Byte-identical behavior | Existing sentinel-driven increment tests pass unmodified. |

## Assumptions

- `tasks.md` lives at `specs/{issueNumber}-{short-name}/tasks.md` under `context.checkoutPath`, discoverable by the prefix-match convention used in `epic-post-tasks.ts`.
- The implement prompt writes tasks as GitHub-style checklist lines (`- [ ]` / `- [x]`); this grammar is the parse contract.
- The fix is orchestrator-internal (`packages/orchestrator/src/worker/`); no change to the agent prompt, the sentinel format, or the label protocol is required.
- This applies uniformly to `workflow:speckit-feature` and `workflow:speckit-bugfix` (both run the implement phase).

## Out of Scope

- Changing the agent prompt or making the sentinel mandatory (the sentinel stays as an optional fast path).
- Redesigning the review→remediate loop or its remediation cap.
- Retroactively repairing issues already advanced to review with unchecked tasks.
- Per-task dependency/ordering awareness — the fallback only counts unchecked vs checked, it does not reason about which tasks were skipped.

---

*Generated by speckit*
