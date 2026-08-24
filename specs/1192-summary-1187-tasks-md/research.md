# Research: tasks.md safety net misses the heading task grammar (#1192)

## Decision 1 — Fix in `countTasks`, not `evaluateTasksMd`

**Decision**: Add the heading grammar to `countTasks`; leave `evaluateTasksMd`,
its discriminated union, and the phase-loop increment block unchanged.

**Rationale**: `evaluateTasksMd` classifies purely on the `{unchecked}` returned
by `countTasks` (`tasks-md-fallback.ts:93-97`): `unchecked > 0` → `incomplete`,
else → `complete`. The bug is upstream — `countTasks` returns `unchecked: 0` for
a heading-format file because it only tests `CHECKBOX_LINE`. Correcting the
counter is sufficient and keeps the fix additive: a heading-format unfinished
file will report `unchecked > 0` and flow through the untouched classification →
synthesis → increment path (FR-007, US3, SC-003).

**Alternatives considered**:
- Add a new evaluator branch or a new `kind`. Rejected — changes the
  `TasksMdEvaluation` shape (spec Out of Scope) and the phase-loop consumer,
  none of which the bug requires.

## Decision 2 — Heading-task detection regex (FR-001, Q3=A)

**Decision**: `HEADING_TASK = /^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b/`.

**Rationale**: The prompt writes heading tasks as `### T001 Description`, ID
immediately after the heading marker. The anchored form (`^#{1,6}[ \t]+T\d+`)
alone still matches `### T001-T026 remaining` because `\b` sits between `1` and
`-`. The negative lookahead `(?![-–—]\s*T?\d)` rejects a range/summary follow-on
(hyphen, en-dash `–`, or em-dash `—`, optional space, optional `T`, a digit)
before the boundary, so range headings count as **zero** tasks (Q3=A). Non-anchored
shapes (`### Phase 3.1: T012`, `### Task T001`, `### Notes on T001`) do not match
and are intentionally not tasks.

**Alternatives considered**:
- Match `T\d+` anywhere in the heading line (Q3 option B). Rejected — over-matches
  section/notes headings that mention IDs, so `unchecked` never reaches zero and
  implement re-enters until the no-progress guard aborts.

## Decision 3 — `[DONE]` position: strict (FR-002, Q2=B)

**Decision**: `HEADING_DONE = /^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]/` — checked only
when `[DONE]` is the token immediately after the task ID; case-sensitive.

**Rationale**: The prompt marks completion as `### T001 [DONE] Description`.
Strict fails loudly: a `[DONE]` written at line end reads as unchecked → implement
re-enters → the no-progress guard surfaces it after one wasted cycle. Lenient
(Q2 option A, `[DONE]` anywhere) fails silently: a title mentioning the marker
(`### T005 Verify [DONE] marker rendering`) reads as checked, `unchecked`
undershoots, implement advances unfinished — the exact #1187 bug. Prefer the loud
failure; B matches the prompt template verbatim (`agency .../implement.md:141-142`).

## Decision 4 — FR-006 distinct log for zero-task-line files (Q1=A)

**Decision**: Relax confinement by one log-only line — add an FR-006 `info` log
in the phase-loop `complete` branch keyed on `evalResult.total === 0`. Evaluator
stays pure; `TasksMdEvaluation` shape unchanged.

**Rationale**: `{kind: 'complete', total: 0}` is structurally distinguishable to
code but nothing prints it, so an operator reading worker logs cannot tell a
"no tasks recognized in either grammar" advance from a legitimate all-complete
advance. A structural field nothing prints is not a diagnostic. The confinement
claim bends by exactly one log-only line rather than breaking the evaluator's
purity (the reason for the confinement).

**Alternatives considered**:
- Treat the field itself as the signal, add no log (Q1 option B). Rejected —
  invisible to operators; FR-006 wants a log-separable signal.

## Decision 5 — Preserve checkbox behavior byte-for-byte (FR-004, US3)

**Decision**: Keep `CHECKBOX_LINE` and its `continue`-first branch exactly as
today; heading detection runs only on lines that did not match a checkbox.

**Rationale**: Guarantees SC-003 (existing checkbox matrix passes unchanged) and
makes a checkbox+heading collision on one line impossible in practice (checkbox
wins, though the two grammars never co-occur on a single line).

## Key sources

- `packages/orchestrator/src/worker/tasks-md-fallback.ts` — current single-grammar counter.
- `packages/orchestrator/src/worker/phase-loop.ts:882-913` — #1187 synthesis + complete-branch.
- `agency packages/agency-plugin-spec-kit/commands/implement.md:141-142,198-199` — the two prompt grammars and the `[DONE]` template.
- `specs/1187-summary-implement-continue/` — the shipped safety net this extends.
