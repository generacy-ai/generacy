# Research: #962 — content guard for `findClarificationComment`

## Decision log

### D1 — Reject list is a positive allow-list, not a wildcard on `<!-- generacy-stage:`

The spec's FR-002 fixes the reject set to exactly six prefixes: `<!-- generacy-stage:{planning,specification,implementation}` and their `<!-- speckit-stage:*` legacy twins. A wildcard on `<!-- generacy-stage:` would be shorter but would break the FR-003 override case for `<!-- generacy-stage:clarification` / `<!-- generacy-stage:clarification-batch-N` — the very markers a real clarification batch carries.

**Alternatives considered:**

- **Wildcard-reject + narrow-accept override.** Reject any `<!-- generacy-stage:*` marker, then accept iff the body also carries one of the two clarification-stage prefixes. Equivalent behaviour on today's marker set, but silently rejects any new stage marker (`<!-- generacy-stage:review`) added tomorrow. The spec §Assumptions is explicit: new stage markers require an explicit reject-list update. Positive allow-list makes that requirement structural.
- **Wildcard-reject on `<!-- generacy-stage:` UNION `<!-- speckit-stage:` with the same override.** Same downside as above; also means the legacy `speckit-stage:` prefix bleeds a new reject entry with every future addition without a code change.

The positive allow-list keeps FR-002 auditable: six literal strings in one `readonly string[]`. Future maintainers grep for `generacy-stage:planning` in the finder and find the guard.

### D2 — Hardcode reject/override lists inside the finder (Q1 → B)

`clarifications.md` Q1/B resolved this: the reject and override lists live inside `clarification-comment-finder.ts` as module-scope `readonly` constants. The finder does NOT import from `packages/orchestrator/src/worker/clarification-markers.ts`.

Rationale, drawn from the clarifications answer:

1. **SC-003 preservation.** The success criterion says "0 changed files outside `clarification-comment-finder.ts` and its test file (plus the mandatory changeset)". Importing from `clarification-markers.ts` puts a second file at risk of touch on any future adjustment (e.g., splitting the constant, exporting a new helper, or moving the file).
2. **Semantic mismatch with `CLARIFICATION_QUESTION_MARKERS`.** The existing constant enumerates *four* prefixes: `<!-- generacy-stage:clarification`, `<!-- generacy-clarifications:`, `<!-- generacy-clarification:`, `<!-- generacy-cockpit:clarifications-batch:`. Only the first two overlap with the FR-003 override list. The other two (`generacy-clarifications:` and `generacy-cockpit:clarifications-batch:`) do NOT start with `<!-- generacy-stage:` and were never rejection candidates to begin with — importing the full list would either force a subset filter in the finder or introduce a fresh export in `clarification-markers.ts` (both moves cross SC-003).
3. **Cross-package coupling avoidance.** The finder lives under `@generacy-ai/generacy`; the marker helper lives under `@generacy-ai/orchestrator`. The two packages already have a dependency edge (cockpit consumes orchestrator types), but this specific guard is a *cockpit* invariant on comments the *cockpit* verb reads. The guard is not the marker helper's contract.

**Trade-off accepted:** the six stage-status prefixes are duplicated between the finder's hardcoded list and `packages/orchestrator/src/worker/types.ts`'s `STAGE_MARKERS`. The paired regression test (FR-006 uses the exact literal `<!-- generacy-stage:planning -->`) makes drift immediately visible in CI; a future stage marker addition (e.g., `<!-- generacy-stage:review`) needs an explicit two-place update. This is called out in plan.md's Constitution check.

### D3 — Body-driven guard, no author lookup (Q2 → A)

`clarifications.md` Q2/A resolved this: the guard is purely body-driven; `IssueComment.author` is not consulted, and no `getCurrentUser()` call is added.

Rationale:

1. **Mirrors `commentCarriesQuestionMarker`.** The existing marker-match helper in `clarification-markers.ts` is author-agnostic. The guard shares its column-0 line-anchored semantics; extending author-agnosticism to the guard keeps the two rules in the same idiom.
2. **No new network dependency.** The finder currently does no identity lookup by design — `getCurrentUser()` would add a per-invocation network round-trip. `cockpit_context` calls the finder on every classification; adding a synchronous network dependency there is a real cost, not a theoretical one.
3. **False-positive is acceptable.** The only body-driven false-positive is a human deliberately opening a comment with `<!-- generacy-stage:planning` at column 0. Vanishingly rare; when it happens, the human is speaking the engine's marker vocabulary, and skipping is arguably correct. The FR-003 override even lets them recover: if they also stamp `<!-- generacy-stage:clarification-batch-N` at column 0, the comment is accepted.

**Alternatives rejected:**

- **B (engine-authored only).** Requires knowing the engine's bot login, which requires `getCurrentUser()`. Buys nothing over A because the false-positive it protects against is not actually a problem.
- **C (all authors + warn log on human-authored hits).** Can't identify "not engine-authored" without the same identity lookup B requires — pays B's cost without B's benefit.

### D4 — Skip-and-continue loop pattern, not filter-then-first

Two implementations achieve the same behaviour:

- **Skip-and-continue** (chosen): the existing `for (const c of sorted)` loop gains a `if (isStageStatusComment(c.body)) continue;` after the timestamp check, before `return c;`. Loop naturally falls through to `return null` when exhausted.
- **Filter-then-first**: pre-filter the sorted list — `sorted.filter(c => !isStageStatusComment(c.body))` — then return `filtered[0] ?? null` for the first surviving at-or-after entry.

Skip-and-continue is chosen because:

1. **Minimal diff.** One-line addition inside an existing loop. The test suite's `[b]` selection assertion in the happy-path test (`expect(c?.url).toBe('b')`) is unchanged.
2. **Preserves the FR-005 contract literally.** "Prefer the earliest by `createdAt` among candidates that survive the guard" is exactly what a `continue` inside an already-sorted-ascending loop does.
3. **Zero allocation.** No intermediate array for a hot-code-adjacent path (the finder is called once per `cockpit_context` invocation; not truly hot, but not worth allocating either).

Filter-then-first would be equivalent, marginally more readable, but is a larger diff and slightly changes the shape of the code the existing tests exercise.

### D5 — Override-first pass ordering (FR-003 mixed-body)

`isStageStatusComment(body)` performs two `body.split('\n')` iterations:

1. **First pass: override check.** Iterate lines; if any line startsWith one of the two `CLARIFICATION_STAGE_OVERRIDE_PREFIXES`, return `false` immediately.
2. **Second pass: reject check.** Iterate lines; if any line startsWith one of the six `STAGE_STATUS_REJECT_PREFIXES`, return `true`.
3. Fall through: return `false`.

The override MUST come first because a mixed body may have the reject marker on line 1 and the override marker on line 3. A single-pass loop that returns `true` on the first reject would miss the override.

**Alternatives considered:**

- **Single pass tracking both flags, decide at end.** Correct but marginally less clear. Two passes with early-return read as "check the escape hatch, then check the reject" — matches the FR-003 wording ("iff … AND neither of these … is at column 0 in the same body").
- **Regex on the full body.** Multiline regex to detect column-0 anchors, one per direction. `body.split('\n')` + `String.startsWith` is faster on small bodies, no regex-compile cost, and unambiguously mirrors `commentCarriesQuestionMarker`'s implementation for reviewer familiarity.

The two-pass helper is O(body-lines × 8) worst case (6 reject + 2 override), which for GitHub comment bodies (rarely >200 lines) is trivially fast.

### D6 — `<!-- generacy-stage:clarification-batch-` needs a trailing hyphen; `<!-- generacy-stage:clarification` does not

The FR-003 override list has two entries:

- `<!-- generacy-stage:clarification` — matches the bare form `<!-- generacy-stage:clarification -->` AND acts as a substring prefix of the batched form.
- `<!-- generacy-stage:clarification-batch-` — matches `clarification-batch-1`, `clarification-batch-12`, `clarification-batch-N`.

The first entry ALONE is a prefix of the second. So `<!-- generacy-stage:clarification-batch-1` would be caught by the first entry, which raises the question: is the second entry redundant?

**Answer: yes for correctness, no for clarity.** The first entry alone suffices — `<!-- generacy-stage:clarification-batch-1` starts-with `<!-- generacy-stage:clarification`. But naming the two forms explicitly matches the spec's FR-003 wording ("`<!-- generacy-stage:clarification` or `<!-- generacy-stage:clarification-batch-N`"), makes the guard's intent legible without cross-referencing, and future-proofs against a maintainer narrowing the first entry to `<!-- generacy-stage:clarification ` (with trailing space) without realizing the batched form would break.

Keeping both entries is deliberate documentation of the two supported shapes.

### D7 — Column-0 rule, no quoted-marker match

The guard's column-0 semantics (`line.startsWith(prefix)` on `body.split('\n')` lines) matches the existing `commentCarriesQuestionMarker` rule exactly. Consequence: a `> <!-- generacy-stage:planning -->` (leading `> ` from a GitHub quote-reply) does NOT trigger the guard. That comment is returned as-is.

This is the desired behaviour per spec §Assumptions: "Quoted (`> `-prefixed) markers do NOT trigger the guard — a human quoting a stage table while writing a real answer still gets their comment returned as the clarification batch."

Regression test coverage: a dedicated case in `clarification-comment-finder.test.ts` asserts a `> <!-- generacy-stage:planning -->` body returns the comment. Confirms the guard inherits the column-0 semantic inline.

### D8 — Regression test FR-006 must be red before the finder change

SC-001 requires the FR-006 test to fail against the current finder implementation (which returns any at-or-after comment regardless of body) and pass against the guarded implementation. This is the load-bearing regression proof — without it, the test is post-hoc coverage, not a regression pin.

Implementation ordering (see tasks.md, next phase):

1. Write and commit the failing FR-006 test first. Run `pnpm --filter @generacy-ai/generacy test clarification-comment-finder` — expect red.
2. Make the finder change. Re-run — expect green.
3. Write remaining regression tests (FR-007, FR-008, plus D7 quoted-marker safety, plus FR-003 mixed-body). These are additive coverage on top of the pinned regression.

## Sources / references

- `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` — the file this spec modifies (~50 LOC today).
- `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` — the existing 4-case test file this spec extends.
- `packages/orchestrator/src/worker/clarification-markers.ts` — the `commentCarriesQuestionMarker` idiom (column-0, line-anchored, prefix-substring) the guard mirrors inline. Deliberately NOT imported (Q1/B).
- `packages/orchestrator/src/worker/types.ts:90-94` — `STAGE_MARKERS` constant, the source-of-truth for the six stage-status literals duplicated into the finder's hardcoded list.
- specs/958-found-during-local-snappoll/spec.md — the upstream `viewerDidAuthor` / marker-authored fix; this spec is defensive against a future regression of that patch's assumption.
- specs/960/spec.md (parent issue) — the symptom this spec closes AC-2 on.

## Non-decisions (deliberately deferred)

- **Extending the reject list to `<!-- generacy-stage:review` or other future stage markers.** Spec §Assumptions: additions require an explicit reject-list update. Not this PR.
- **Author-aware guard.** Rejected by Q2/A; not revisiting until the finder gains a network dependency for some other reason.
- **Parsing the returned comment body for `Q<n>:` structure.** Spec §Out of Scope. The guard is a marker allow-list only; comments carrying neither a stage-status marker nor a clarification-question marker are still returned (matches today's behaviour for human-authored comments).
- **Changes to the label-timing branch** (timeline walk, latest-`waiting-for:clarification` selection, `createdAt >= labelTs` gate). Spec §Out of Scope.
- **Changes to `clarification-poster.ts`, `clarification-markers.ts`, or `STAGE_MARKERS`.** Spec §Out of Scope. This spec only *reads* those literals (by hardcoded duplication in the finder); it does not modify them.
