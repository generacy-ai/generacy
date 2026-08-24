# Clarifications: tasks.md safety net misses the heading task grammar (#1192)

## Batch 1 — 2026-08-24

### Q1: FR-006 distinct-log location vs. single-file confinement
**Context**: FR-006 wants the "zero task lines of either grammar" case to emit a
log signal distinct from an ordinary all-complete file. But the evaluator
(`evaluateTasksMd`) is pure/loggerless, the `TasksMdEvaluation` shape must stay
unchanged (Assumptions), the phase-loop `complete` branch
(`phase-loop.ts:906-913`) currently logs nothing, and the fix is asserted to be
confined to `tasks-md-fallback.ts` + its test. These constraints collide.
**Question**: How should the FR-006 distinct signal be surfaced?
**Options**:
- A: Relax confinement for one line — add an FR-006 log in the phase-loop
  `complete` branch keyed on `total === 0` (evaluator/shape unchanged; only a
  log-only edit to phase-loop.ts).
- B: Stay strictly confined — treat `complete` with `total: 0` as the signal
  itself (structurally distinguishable in the returned result); add no new log
  line. FR-006 is SHOULD/P2, satisfied by the field, not a log.
- C: Something else (specify).

**Answer**: *Pending*

### Q2: Heading `[DONE]` marker position
**Context**: FR-002 marks a heading task checked when it "carries a `[DONE]`
marker after the task ID." The implement prompt writes it immediately after the
ID: `### T001 [DONE] Description`. The regex design depends on how strict this
match is.
**Question**: Where may `[DONE]` appear to count a heading task as checked?
**Options**:
- A: Anywhere on the line after the task ID (lenient — `### T001 Description
  [DONE]` also counts as done).
- B: Immediately after the task ID token only (strict — matches the prompt's
  exact `### T001 [DONE] ...` position).

**Answer**: *Pending*

### Q3: Heading task-ID anchoring
**Context**: FR-001's regex `^#{1,6}[ \t]+T\d+\b` requires the `T\d+` token
immediately after the heading marker + whitespace. Real files sometimes phrase
headings as `### Phase 3.1: T012 ...` or `### Task T001` (ID not first), and a
summary heading like `### T001-T026 remaining` would match the anchored regex
and be counted as an unchecked task.
**Question**: Should heading detection require the task ID immediately after the
`#`s (per FR-001's regex as written), or match a `T\d+` token anywhere in the
heading text?
**Options**:
- A: Keep FR-001's anchored regex as written — ID must immediately follow the
  heading marker; accept that non-anchored headings are not tasks.
- B: Match a `T\d+` token anywhere in the heading line (more permissive; risks
  counting summary/section headings that mention task IDs).

**Answer**: *Pending*
