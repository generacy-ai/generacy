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

**Answer**: A — relax the confinement by exactly one line: add an FR-006 log in
the phase-loop `complete` branch keyed on `total === 0`. The evaluator stays
pure/loggerless and `TasksMdEvaluation` is unchanged. Rationale: `{kind:
'complete', total: 0}` is structurally distinguishable to code but invisible to
an operator reading worker logs — a structural field nothing prints is not a
diagnostic. The confinement claim bends by one log-only line rather than
breaking; the evaluator's purity (the reason for the confinement) is untouched.

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

**Answer**: B — strict: `[DONE]` counts only immediately after the task-ID
token, matching the prompt's exact `### T001 [DONE] Description` position.
Rationale: leniency fails silently — a title that legitimately mentions the
marker (`### T005 Verify [DONE] marker rendering`) would read as checked, the
unchecked count undershoots, and implement advances with work unfinished (the
exact #1187 bug). Strict fails loudly — a marker written at line end reads as
unchecked, implement re-enters, and the no-progress guard surfaces it after one
wasted cycle. Prefer the loud failure. B also matches the prompt's template
verbatim (`agency .../commands/implement.md:141-142`).

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

**Answer**: A — keep FR-001's anchored regex (the ID must immediately follow the
heading marker). **Additionally**, close the range/summary false positive: the
question's own example `### T001-T026 remaining` matches the anchored regex too,
because `\b` sits between the `1` and the `-`. Anchoring alone does not fix it.
Tighten the boundary so a range/summary follow-on is rejected, e.g.
`^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b`, and add `### T001-T026 remaining` (plus
en-dash and em-dash variants) as explicit fixtures asserting **zero** tasks
counted. Rationale: option B over-matches (`### Notes on T001`,
`### Rework after T012` would count as unchecked tasks, so the count never
reaches zero and implement re-enters until the no-progress guard aborts). The
non-anchored `### Phase 3.1: T012` / `### Task T001` shapes, if real, get their
own explicit alternatives + fixtures later — not blanket permissiveness.
