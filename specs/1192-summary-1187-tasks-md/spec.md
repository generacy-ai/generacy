# Feature Specification: tasks.md safety net misses the heading task grammar

**Branch**: `1192-summary-1187-tasks-md` | **Date**: 2026-08-24 | **Status**: Draft
**Issue**: [#1192](https://github.com/generacy-ai/generacy/issues/1192) | **Workflow**: `speckit-bugfix`

## Summary

The #1187 `tasks.md` safety net (merged in #1188, `4e0ad874`) counts only
GitHub-style checkbox task lines. The implement prompt recognizes **two** task
grammars — checkbox (`- [ ] T001`) and heading (`### T001`). A `tasks.md`
written in the heading grammar parses as **zero task lines** in
`countTasks`, so `evaluateTasksMd` classifies it as `complete`, the safety net
no-ops, `completed:implement` is granted, and a substantially-unfinished tree
advances into review→remediate — silently reproducing exactly the bug #1187 was
built to prevent.

The failure is silent and inverted: the safety net reports `complete` with
maximum confidence precisely when it understands the file least, and a
`{kind: 'complete', total: 0}` heading-grammar file is indistinguishable in the
logs from a legitimately task-less story that FR-004 (of #1187) deliberately
advances.

## Root cause

`packages/orchestrator/src/worker/tasks-md-fallback.ts:24` defines a single
grammar:

```ts
const CHECKBOX_LINE = /^[ \t]*[-*+] \[( |x|X)\]/;
```

`countTasks` (`:31`) tests every line against `CHECKBOX_LINE` and ignores
non-matching lines. A heading-grammar task list therefore yields
`{unchecked: 0, checked: 0, total: 0}`; `evaluateTasksMd` (`:93-97`) sees
`unchecked === 0` and returns `{kind: 'complete', ...}`. No `unreadable` reason
is logged, so there is no operator signal.

The implement prompt's own completion definition
(`agency packages/agency-plugin-spec-kit/commands/implement.md:141-142,198-199`)
recognizes both grammars:

- **Checkbox**: `- [ ] T001` unchecked → `- [X] T001` done.
- **Heading**: `### T001 Description` unchecked → `### T001 [DONE] Description` done.

So the engine's fallback and the agent's own definition of "done" disagree about
what a task is. #1187's shipped FR-007 pins only the checkbox grammar (the
dual-grammar note was raised in #1187's clarification round but lost when the
clarifications file was corrupted by #1189), so the implementation matches its
spec — the gap is in the spec.

## User Stories

### US1: Heading-grammar unfinished work re-enters implement (Primary)

**As an** operator driving a speckit workflow whose `tasks.md` uses the heading
grammar,
**I want** the engine safety net to recognize unchecked heading-format tasks,
**So that** an unfinished implement phase re-enters (via the existing #1187
increment) instead of silently advancing into review with the work incomplete.

**Acceptance Criteria**:
- [ ] A `tasks.md` containing `### T001` heading tasks with no `[DONE]` marker
  classifies as `incomplete` (not `complete`).
- [ ] `tasks_remaining` / `tasks_completed` / `tasks_total` for a heading-grammar
  file are counted the same way as for a checkbox file (a `[DONE]` heading counts
  as checked; a bare heading task counts as unchecked).
- [ ] A mixed checkbox + heading `tasks.md` sums both grammars into one tally.

### US2: Genuinely task-less stories still advance, distinguishably

**As an** operator,
**I want** a `tasks.md` that matched a spec dir but contains zero task lines of
*either* grammar to still advance (fail-open, per #1187 FR-004) but emit a
distinct log signal,
**So that** "no tasks recognized" is distinguishable in the logs from
"legitimately task-less story."

**Acceptance Criteria**:
- [ ] A resolved `tasks.md` with zero task lines of either grammar advances the
  phase (does not stall, does not re-enter).
- [ ] That case emits a distinct log line separable from an ordinary all-complete
  file and from an `unreadable` reason.

### US3: Existing checkbox behavior is unchanged

**As a** maintainer,
**I want** all existing checkbox-grammar behavior to remain byte-identical,
**So that** this fix is purely additive and cannot regress the #1187 path.

**Acceptance Criteria**:
- [ ] Every existing `countTasks` / `evaluateTasksMd` checkbox test still passes.
- [ ] `unreadable` classification (missing/ambiguous spec dir, unreadable
  `tasks.md`) is unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `countTasks` MUST recognize heading-grammar task lines matching an anchored regex where the `T\d+` ID immediately follows the heading marker + whitespace, in addition to the existing checkbox grammar. The boundary MUST reject range/summary follow-ons (`### T001-T026 remaining` and en-dash/em-dash variants) which the bare `\b` boundary would otherwise count. Use `^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b`. Non-anchored shapes (`### Phase 3.1: T012`, `### Task T001`) are deliberately NOT tasks (clarify Q3=A). | P1 | Same file, `tasks-md-fallback.ts`. |
| FR-002 | A heading task line is **checked** only when a `[DONE]` marker appears **immediately after the task-ID token** (`### T001 [DONE] ...`), **unchecked** otherwise (clarify Q2=B — strict position; a `[DONE]` elsewhere on the line does NOT count as done). | P1 | Mirrors implement prompt `:141-142` verbatim. |
| FR-003 | Both grammars MUST feed the same `{unchecked, checked, total}` tally; mixed-grammar files sum both. | P1 | Keeps `tasks_remaining` comparable across increments. |
| FR-004 | Existing checkbox counting behavior MUST remain unchanged (unchecked on a single-space capture, checked on `x`/`X`). | P1 | Additive only. |
| FR-005 | A resolved `tasks.md` with zero task lines of either grammar MUST still classify as `complete` and advance (fail-open, preserving #1187 FR-004). | P2 | Do not turn task-less into `unreadable`. |
| FR-006 | The zero-task-lines-of-either-grammar case SHOULD emit a distinct log signal, separable from an ordinary all-complete file. The signal is a log-only line in the phase-loop `complete` branch (`phase-loop.ts:906-913`) keyed on `total === 0`; the `evaluateTasksMd` evaluator stays pure/loggerless and the `TasksMdEvaluation` shape is unchanged (clarify Q1=A). | P2 | Confinement relaxes by exactly one log-only line in phase-loop.ts; classification unchanged. |
| FR-007 | `evaluateTasksMd`'s `unreadable` paths (missing/ambiguous spec dir, unreadable `tasks.md`) MUST be unchanged. | P1 | No regression to fail-open resolution. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Heading-format unfinished `tasks.md` classifies `incomplete` | 100% | `evaluateTasksMd` unit test on a `### T001`-only fixture returns `kind: 'incomplete'`. |
| SC-002 | Grammar matrix parity | pass | `countTasks` tests: `### T001` → unchecked; `### T001 [DONE]` → checked; mixed file → summed; `### T001 Description [DONE]` (marker at line end) → unchecked (Q2=B); `### T001-T026 remaining` + en-dash/em-dash variants → zero tasks (Q3=A boundary). |
| SC-003 | No regression on checkbox grammar | 100% | Existing `tasks-md-fallback.test.ts` checkbox matrix passes unchanged. |
| SC-004 | Task-less story still advances | pass | A zero-task-line-of-either-grammar `tasks.md` returns `complete` (fail-open). |

## Assumptions

- The heading grammar is `#{1,6}` heading levels followed by a task ID token
  `T\d+`; the `[DONE]` marker appears after the task ID (per the implement
  prompt's mark-complete step).
- `[DONE]` detection is case-sensitive matching the prompt's literal `[DONE]`.
- The fix is confined to `packages/orchestrator/src/worker/tasks-md-fallback.ts`
  and its test file, **plus one log-only line** in the phase-loop `complete`
  branch (`phase-loop.ts:906-913`) for FR-006 (clarify Q1=A). The phase-loop
  increment wiring (#1187) is otherwise unchanged and consumes the same
  `TasksMdEvaluation` shape.
- Applies to both `workflow:speckit-feature` and `workflow:speckit-bugfix`, since
  the fallback is workflow-agnostic.

## Out of Scope

- Any change to the #1187 phase-loop increment block, `ImplementPartialResult`
  synthesis mapping, or the sentinel fast path.
- Changing the implement prompt or its task grammars (`agency` repo).
- New label vocabulary or new persisted state.
- Adding an absolute increment cap (the existing no-progress guard is retained).

---

*Generated by speckit*
