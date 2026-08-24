# Implementation Plan: Engine-side tasks.md safety net for the implement→continue increment

**Feature**: Re-enter the implement phase when `tasks.md` still has unchecked tasks and the agent omitted the `SPECKIT_IMPLEMENT_PARTIAL` sentinel, instead of granting `completed:implement` and advancing to review with unfinished work.
**Branch**: `1187-summary-implement-continue`
**Status**: Complete

## Summary

The implement→continue increment depends entirely on the agent emitting a
`SPECKIT_IMPLEMENT_PARTIAL: {...}` sentinel. When the agent stops mid-tasklist
without emitting it, `result.implementResult === undefined`, the re-loop at
`phase-loop.ts:873` is skipped, `completed:implement` is granted, and a
substantially unfinished implementation advances into review→remediate (which
caps and stalls — the #26 incident).

The fix adds an **engine-side fallback**: after a `success` implement phase with
**no** sentinel, parse the workflow's `tasks.md`, count unchecked `- [ ]` tasks,
and — when work remains — **synthesize** a `result.implementResult` so the
existing increment block (`phase-loop.ts:873–937`) handles the re-entry
(WIP commit/push, fresh session, no-progress guard, `i--; continue`) unchanged.
The sentinel stays the fast path; `tasks.md` becomes the fallback source of truth
for whether implement is actually complete.

## Clarification resolutions

The four clarifications (`clarifications.md`) are resolved from the spec's own
internal constraints:

- **Q1 = A** — Sentinel stays authoritative. The fallback runs **only** when the
  sentinel is absent (`implementResult === undefined`), matching FR-001's gate
  and SC-005 (sentinel path byte-identical). A present sentinel is never
  overridden by tasks.md.
- **Q2 = B** — Per-path count source. The sentinel path keeps feeding the agent's
  self-reported `tasks_remaining`; the fallback path feeds the tasks.md unchecked
  count. Preserves SC-005; the fallback never runs on a sentinel-present run so
  there is no mixed comparison within a single continuation.
- **Q3 = A** — No absolute increment cap. Rely solely on the existing no-progress
  guard (FR-002/FR-003 say "reuse the existing block"; US3 references the guard,
  not a new counter).
- **Q4 = A** — Zero task lines = complete. A found-but-taskless `tasks.md` advances
  as a task-less story (FR-004); only genuine I/O/parse failure or a missing /
  ambiguous spec dir logs the FR-006 "cannot read" reason.

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`).
- **Test framework**: Vitest (`packages/orchestrator/src/worker/__tests__/`).
- **Fix locus**: `packages/orchestrator/src/worker/` — orchestrator-internal.
  No agent-prompt change, no sentinel-format change, no label-protocol change.
- **Applies to**: `workflow:speckit-feature` and `workflow:speckit-bugfix`
  (both run the implement phase; the fallback is workflow-agnostic).
- **Dir-resolution convention**: `specs/{issueNumber}-*` prefix-match under
  `context.checkoutPath` — the same convention as
  `epic-post-tasks.ts:293` (`resolveFeatureDir`), extended here to detect the
  zero-match and multiple-match cases explicitly for FR-006.
- **Checkbox grammar**: GitHub-style checklist lines — unchecked `- [ ]`,
  checked `- [x]` / `- [X]`. Regex `^[ \t]*[-*+] \[( |x|X)\]` (FR-007).

## Design

### Synthesis approach (the load-bearing decision)

Rather than duplicate the increment machinery, the fallback **synthesizes** the
same `result.implementResult` shape the sentinel parser produces. A new block
inserted immediately **before** `phase-loop.ts:873` runs only when
`phase === 'implement' && result.success && result.implementResult === undefined`.
It evaluates tasks.md and, when unchecked tasks remain, sets:

```ts
result.implementResult = {
  partial: true,
  tasks_remaining: <unchecked count>,
  tasks_completed: <checked count>,
  tasks_total: <total task lines>,
};
```

The existing block at 873 then does everything: the no-progress guard
(fed the tasks.md count via FR-003), the WIP commit/push, the fresh-session
reset, and `i--; continue`. This satisfies FR-002 (reuse the block), FR-003
(guard fed the unchecked count), Q1=A (fires only when sentinel absent), and
Q2=B/SC-005 (sentinel path untouched) by construction.

When tasks.md is fully checked, has zero task lines, or cannot be read, the
synthesis block leaves `result.implementResult` undefined → the 873 block is
skipped → the phase advances (granting `completed:implement`), exactly as today.
The unreadable case additionally logs the FR-006 reason.

### New module — `tasks-md-fallback.ts`

A small, mostly-pure evaluator with a discriminated-union result:

```ts
type TasksMdEvaluation =
  | { kind: 'incomplete'; unchecked: number; checked: number; total: number }
  | { kind: 'complete';   unchecked: 0;      checked: number; total: number }
  | { kind: 'unreadable'; reason: string };
```

- `incomplete` → synthesize `implementResult` → re-enter implement.
- `complete` → advance (covers all-checked **and** zero-task-lines per FR-004/Q4-A);
  no FR-006 log.
- `unreadable` → advance + log FR-006 reason (covers missing spec dir, ambiguous
  multiple matching dirs, missing/unreadable/undecodable `tasks.md`).

Wired into `phase-loop.ts` via a new optional `PhaseLoopDeps` field (same
optional-injection pattern as `remediateTrigger` / `phaseTracker` /
`reviewExecutor`), defaulting to the real FS-backed evaluator so production picks
it up and tests can inject a stub.

## Project structure

```
packages/orchestrator/src/worker/
  tasks-md-fallback.ts                     # NEW — evaluator + checkbox parser + dir resolution
  phase-loop.ts                            # MODIFY — synthesis block before :873; PhaseLoopDeps field
  claude-cli-worker.ts                     # MODIFY — wire default evaluator into PhaseLoopDeps
  __tests__/
    tasks-md-fallback.test.ts              # NEW — parser + dir-resolution + classification matrix
    phase-loop.test.ts                     # MODIFY — no-sentinel re-entry, no-progress abort, fail-open advance
specs/1187-summary-implement-continue/
  plan.md research.md data-model.md quickstart.md contracts/tasks-md-fallback-evaluator.md
.changeset/
  1187-tasks-md-safety-net.md              # NEW — @generacy-ai/orchestrator patch
```

## Constitution check

No `.specify/memory/constitution.md` exists in this repository — constitution
check skipped.

## Changeset

`.changeset/1187-tasks-md-safety-net.md` — `@generacy-ai/orchestrator` **patch**
(`workflow:speckit-bugfix`; internal `worker/` behavior fix, no new public
exports, no new label vocabulary). Non-test `packages/orchestrator/src/` change
→ changeset required per CLAUDE.md gate.

---

*Generated by speckit*
