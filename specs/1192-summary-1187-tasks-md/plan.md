# Implementation Plan: tasks.md safety net misses the heading task grammar

**Feature**: Teach the #1187 `tasks.md` safety net to recognize the heading task grammar (`### T001` / `### T001 [DONE]`) in addition to the checkbox grammar, so a heading-format `tasks.md` with unfinished work re-enters the implement phase instead of silently advancing.
**Branch**: `1192-summary-1187-tasks-md`
**Status**: Complete

## Summary

The #1187 safety net (`tasks-md-fallback.ts`) counts only GitHub-style checkbox
task lines (`- [ ] T001`). The implement prompt recognizes **two** task grammars
— checkbox and heading (`### T001` unchecked → `### T001 [DONE]` done). A
`tasks.md` written in the heading grammar parses as **zero task lines** in
`countTasks`, so `evaluateTasksMd` returns `{kind: 'complete', total: 0}`, the
safety net no-ops, `completed:implement` is granted, and a substantially
unfinished tree advances into review→remediate — silently reproducing the exact
bug #1187 was built to prevent.

The fix is additive and confined to `countTasks`: add a second grammar
(heading-task detection with strict `[DONE]` position and a boundary that rejects
range/summary follow-ons), feeding the **same** `{unchecked, checked, total}`
tally so mixed files sum both. Plus one log-only line in the phase-loop
`complete` branch, keyed on `total === 0`, so the "no tasks recognized" case is
distinguishable in operator logs from a legitimately task-less story (FR-006).

## Clarification resolutions

The three clarifications (`clarifications.md`) are resolved as:

- **Q1 = A** — Relax the single-file confinement by exactly one line: add an
  FR-006 log in the phase-loop `complete` branch keyed on `total === 0`. The
  evaluator stays pure/loggerless and the `TasksMdEvaluation` shape is unchanged.
  A `{kind: 'complete', total: 0}` field is structurally distinguishable to code
  but invisible to an operator reading worker logs; a structural field nothing
  prints is not a diagnostic.
- **Q2 = B** — Strict `[DONE]` position: a heading task is checked **only** when
  `[DONE]` appears immediately after the task-ID token (`### T001 [DONE] ...`).
  Leniency fails silently (a title mentioning the marker reads as checked and
  implement advances unfinished); strict fails loudly (a marker at line end reads
  as unchecked, implement re-enters, the no-progress guard surfaces it after one
  wasted cycle). B matches the prompt template verbatim.
- **Q3 = A** — Keep the anchored regex (ID immediately after the heading marker)
  **and** tighten the boundary with `(?![-–—]\s*T?\d)` so range/summary headings
  (`### T001-T026 remaining`, en-dash/em-dash variants) count as **zero** tasks.
  Non-anchored shapes (`### Phase 3.1: T012`, `### Task T001`) are deliberately
  not tasks.

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`).
- **Test framework**: Vitest (`packages/orchestrator/src/worker/__tests__/`).
- **Fix locus**: `packages/orchestrator/src/worker/tasks-md-fallback.ts` (grammar
  + counting) and `phase-loop.ts` (one FR-006 log-only line). Orchestrator-internal.
  No agent-prompt change, no sentinel-format change, no label-protocol change, no
  new persisted state, no new public exports.
- **Applies to**: `workflow:speckit-feature` and `workflow:speckit-bugfix` (both
  run implement; the fallback is workflow-agnostic).
- **Checkbox grammar (unchanged)**: `^[ \t]*[-*+] \[( |x|X)\]`.
- **Heading grammar (new)**: detect `^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b`;
  checked iff `[DONE]` immediately follows the task-ID token.

## Design

### The load-bearing decision: extend `countTasks`, not `evaluateTasksMd`

`evaluateTasksMd` already routes entirely off `countTasks`'s `{unchecked}`:
`unchecked > 0` → `incomplete`, else → `complete`. Teaching `countTasks` the
heading grammar makes a heading-format unfinished file report `unchecked > 0`,
which flows through `evaluateTasksMd` → the phase-loop synthesis block → the
existing #1187 increment machinery with **zero** changes downstream. The
discriminated union, the FS resolution, the `unreadable` paths, and the phase-loop
increment block are all untouched (FR-007, US3).

### Grammar in `countTasks`

Two module-level regexes are added alongside `CHECKBOX_LINE`:

```ts
// Heading task: ID immediately after the heading marker; boundary rejects
// range/summary follow-ons (### T001-T026 remaining, en-/em-dash variants).
const HEADING_TASK = /^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b/;
// Checked only when [DONE] is immediately after the task-ID token (Q2=B strict).
const HEADING_DONE = /^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]/;
```

Per-line loop: try `CHECKBOX_LINE` first (existing branch, `continue` on match to
preserve byte-identical checkbox behavior — FR-004); otherwise test
`HEADING_TASK`; on a heading-task match, `HEADING_DONE.test(line)` decides
checked vs. unchecked. Both grammars increment the same `unchecked` / `checked`
counters, so mixed files sum (FR-003).

### FR-006 log-only line

The phase-loop `complete`-branch (`phase-loop.ts:906-913`) currently no-ops on
`complete`. Add an `else if (evalResult.kind === 'complete' && evalResult.total
=== 0)` branch emitting a distinct `info` line ("tasks.md safety net: advancing —
no task lines recognized in either grammar"). The evaluator stays pure; only the
phase-loop gains one log-only branch. `complete` with `total > 0` (all-checked)
stays silent, exactly as today.

## Project structure

```
packages/orchestrator/src/worker/
  tasks-md-fallback.ts                     # MODIFY — add HEADING_TASK/HEADING_DONE + counting branch
  phase-loop.ts                            # MODIFY — one FR-006 log-only line in the complete branch
  __tests__/
    tasks-md-fallback.test.ts              # MODIFY — heading grammar matrix, [DONE] position, boundary, mixed
    phase-loop.test.ts                     # MODIFY (if needed) — FR-006 total===0 log signal
specs/1192-summary-1187-tasks-md/
  plan.md research.md data-model.md quickstart.md
  contracts/tasks-md-grammar.md
.changeset/
  1192-tasks-md-heading-grammar.md         # NEW — @generacy-ai/orchestrator patch
```

## Constitution check

No `.specify/memory/constitution.md` exists in this repository — constitution
check skipped.

## Changeset

`.changeset/1192-tasks-md-heading-grammar.md` — `@generacy-ai/orchestrator`
**patch** (`workflow:speckit-bugfix`; internal `worker/` behavior fix, no new
public exports, no new label vocabulary). Non-test `packages/orchestrator/src/`
change → changeset required per CLAUDE.md gate.

---

*Generated by speckit*
