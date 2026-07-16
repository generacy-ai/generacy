# Implementation Plan: Widen the deterministic clarification-answer parser to accept the cockpit dialect

**Feature**: The cockpit plugin posts clarification-answer comments in a body shape (`### Q<n>` with `**Answer:** value`) that the orchestrator's deterministic `parseAnswersFromComments` cannot read. Three regex misses are load-bearing: the outer opener requires a colon after `Q<n>`, the outer terminator lookahead requires the same colon (so widening only the opener silently swallows every question after the first in a batched cockpit body), and `extractEmbeddedAnswer` has no arm for `**Answer:** value`. Widen the engine parser to accept both dialects — do not change the cockpit posted format, which is byte-locked by contract in `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md`.
**Branch**: `949-summary-cockpit-plugin-posts`
**Status**: Complete

## Summary

`parseAnswersFromComments` at `packages/orchestrator/src/worker/clarification-poster.ts:445` finds **zero** answers in a cockpit-posted comment. Root cause is a triple regex miss (spec §Root cause). End-to-end nothing looks broken today because the LLM resume path in `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:94` writes the answers into `clarifications.md` before the `on-questions` gate ever calls the deterministic backstop — but that means the module *documented as the safety net when the LLM/CLI fails to persist answers* is silently dead for every cockpit answer, and two guard features (FR-013 untrusted-author explainer, FR-002 content sniff) are gated behind the same regex and therefore inert for the cockpit dialect.

The fix is a single-file surgical change to `clarification-poster.ts`:

1. Extract one **shared opener pattern constant** (MUST, per clarification Q3). The shared fragment matches `<optional heading> Q<n> <optional colon-and-topic>` line-anchored. It composes into **three** sites: the outer opener at `:457-458`, the outer terminator lookahead at `:457-458`, and `commentMatchesAnswerPattern` at `:97-99`. Two duplicate copies fail acceptance.
2. Widen the outer regex opener at `:457-458` so `### Q1` (no colon) opens a block, matching the byte-locked cockpit shape. Colon-less form REQUIRES a markdown heading prefix (per Q2→A); bare line-start `Q1\n…` does NOT open a block. FR-005 line anchoring is preserved so `as per Q1: yes` still cannot capture.
3. Widen the terminator lookahead in **exact lockstep** with the opener at the same lines. Missing this yields a 2-question cockpit body that opens exactly one block (Q1's lazy `(.*?)` swallows Q2 verbatim). Cockpit batches answers so multi-question is the normal case, not an edge — this miss is the primary defect, not incidental.
4. Add `**Answer:** value` as a third accepted form in `extractEmbeddedAnswer` at `:406-420`, alongside the existing `**Answer: X**` and `**Answer**: X`.
5. **Explicitly exclude** `sourceHadQuestionHeadings` at `:453` (`/(?:^|\n)###\s+Q\d+:/`) from the shared constant. Its colon is load-bearing (Q5→C): it discriminates engine-authored questions (`### Q1: Topic`) from cockpit answer delimiters (`### Q1`). Firing FR-004's "possible bot self-answer" warning on every legitimate cockpit integration would be a 100%-rate false positive. Add a code comment at `:453` recording that the colon is deliberate.

**Rationale-line disposition (per Q1→B, corrected).** The Q1 clarification answer in `clarifications.md` is corrupted at the persistence layer (the writer's regex-replace inside the answer body consumed the `**`), but the operator's chosen option is unambiguously **B**: the captured answer for a cockpit block MUST include the immediately-following `**Rationale:** …` line joined onto the answer value, so `clarifications.md` preserves the *why* alongside the *what*. Implementation: `extractEmbeddedAnswer` returns `"<answer-value>\nRationale: <rationale-value>"` when a `**Rationale:** …` line follows the `**Answer:** …` line inside the same Q block; the existing single-string `ParsedAnswer.answer` shape is preserved.

**Scope**: `packages/orchestrator/src/worker/clarification-poster.ts` (widen + refactor to one shared constant) and its Vitest fixtures. No changes to the cockpit posted format (locked). No changes to `clarify.ts`, `phase-loop.ts`, or the FR-004 discriminator at `:453`. No new dependencies. No wire-protocol changes.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Package `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Target module**: `packages/orchestrator/src/worker/clarification-poster.ts` — single file, four call sites listed below.
- **Call sites for the shared opener**:
  1. Outer opener at `:457-458` — `parseAnswersFromComments` outer regex.
  2. Outer terminator lookahead at `:457-458` (same regex, different position) — must widen in lockstep with the opener.
  3. `commentMatchesAnswerPattern` at `:97-99` — used by the FR-013 untrusted-author explainer to decide whether a skipped comment warrants a public explainer.
- **Deliberately excluded from the shared constant** (Q5→C): `sourceHadQuestionHeadings` at `:453` — colon-required discriminator between engine-authored question comments and cockpit answer delimiters. The FR-004 residual-race warning depends on this asymmetry.
- **Write-back pattern check**: `:730-732` (``` `### Q${n}:[\s\S]*?\*\*Answer\*\*:\s*\*Pending\*` ```) targets `clarifications.md`, which uses the engine dialect (`### Q1:` / `**Answer**: *Pending*`) — internally consistent. Confirm no change needed once the opener widens; do not modify speculatively.
- **Cockpit posted format** (byte-locked, do not change):
  - Marker: `<!-- generacy-cockpit:clarification-answers -->`
  - Per-block: `### Q<n>\n**Answer:** <value>\n**Rationale:** <text>`
  - Source-of-truth: `agency/packages/claude-plugin-cockpit/commands/clarify.md:69-71`, `auto.md:273`, contract `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md`.
- **Engine/human dialect** (existing regression coverage, must keep passing):
  - `### Q<n>: Topic\n**Answer: X** — text`
  - `### Q<n>: Topic\n**Answer**: X`
  - Bare `Q<n>: answer text`
- **Test runner**: Vitest. Tests live under `packages/orchestrator/src/worker/__tests__/clarification-poster*.test.ts`. `parseAnswersFromComments` is currently *indirectly* covered through `integrateClarificationAnswers`; new opener-regex behavior can be pinned either way.
- **Fixture requirement** (MUST, Q4→A): at least one test fixture MUST be captured verbatim from a real cockpit-posted issue comment AND MUST be multi-question (≥ 2 `### Q<n>` blocks). Issue #949's own cockpit-format answer comment satisfies this (though see Note on Q1 answer corruption below).
- **New dependencies**: none.

## Constitution Check

No `.specify/memory/constitution.md` exists — no project-level constitutional constraints to verify. The change respects standing generacy conventions:

- **Additive-only regex widening**: all three pre-existing dialects (`### Q<n>: Topic`, `**Q<n>**:`, bare `Q<n>:`) continue to match the shared opener. No consumer of `parseAnswersFromComments` sees a shape change beyond the new cockpit-shaped answers now integrating instead of silently no-opping.
- **No cross-package changes**: single-file change in `packages/orchestrator/src/worker/clarification-poster.ts`. `packages/workflow-engine`, `packages/generacy` (cockpit), and `agency` (byte-locked cockpit contract) are untouched.
- **Fail-loud on the load-bearing test**: the multi-question fixture (SC-002-adjacent, spec §Tests) MUST fail if the terminator lookahead is not widened in lockstep with the opener. A single-question fixture goes green with the primary defect live, so it would let the regression through — the multi-question test is load-bearing and stays MUST.
- **Preserve FR-005 line anchoring**: mid-prose `as per Q1: yes` must still not open a block (regression test required).
- **Preserve FR-002 content sniff**: `**Question**:` / `**Context**:` inside a captured answer body remains a signal to skip as leaked bot question body. Widening the opener must not weaken this guard; regression asserted.
- **Preserve FR-004 semantics** (Q5→C): the residual-race detector `TRANSITION_WITH_QUESTION_HEADINGS` MUST NOT fire on well-formed cockpit answer comments. Pin this as a negative regression test, and pin `sourceHadQuestionHeadings` at `:453` as explicitly outside the shared constant with a code comment.
- **No wire-protocol or schema change**: `ParsedAnswer.answer` remains `string`. The rationale-line join (Q1→B) is encoded inside that single string, not as a new struct field — this preserves every downstream consumer without a schema bump.

## Project Structure

```
packages/orchestrator/
└── src/
    └── worker/
        ├── clarification-poster.ts                              # MODIFIED — extract QN_OPENER_PATTERN shared constant;
        │                                                        #   widen outer regex opener + terminator lookahead at :457-458 in lockstep;
        │                                                        #   add `**Answer:** value` arm to extractEmbeddedAnswer at :406-420;
        │                                                        #   append `\nRationale: <text>` when a **Rationale:** line follows (Q1→B);
        │                                                        #   add code comment at :453 recording that the colon is deliberate (Q5→C)
        │                                                        #   and that this discriminator is deliberately outside QN_OPENER_PATTERN
        └── __tests__/
            └── clarification-poster.test.ts                     # MODIFIED — add:
                                                                 #   * multi-question cockpit fixture (≥2 blocks, captured verbatim
                                                                 #     from a real cockpit-posted issue comment per Q4→A)
                                                                 #   * single-question cockpit dialect regression
                                                                 #   * regression tests for all three pre-existing dialects
                                                                 #   * mid-prose "as per Q1: yes" MUST NOT capture (FR-005)
                                                                 #   * bare line-start "Q1\n**Answer:** X" MUST NOT capture (Q2→A)
                                                                 #   * FR-013 untrusted cockpit-format answer produces explainer
                                                                 #   * FR-002 leaked `**Question**:` inside answer still skipped
                                                                 #   * FR-004 NEGATIVE: cockpit answer integrates WITHOUT
                                                                 #     TRANSITION_WITH_QUESTION_HEADINGS (Q5→C)
                                                                 #   * Q1→B rationale-line join included in persisted answer
```

Full source-tree impact: **1 file modified in orchestrator/src, 1 test file extended, 0 new files, 0 package.json changes, 0 new dependencies.**

## Design

### The shared opener constant

New top-of-file constant, colocated with the other regex-fragment helpers:

```ts
/**
 * Shared opener fragment for a `Q<n>` clarification-answer block.
 *
 * Composes into three sites:
 *   1. Outer regex opener (parseAnswersFromComments)
 *   2. Outer regex terminator lookahead (parseAnswersFromComments) — must
 *      stay in lockstep with (1) or multi-question cockpit bodies open
 *      exactly one block (Q1 swallows Q2..Qn to EOF).
 *   3. commentMatchesAnswerPattern — used by the FR-013 explainer gate.
 *
 * DELIBERATELY NOT USED by sourceHadQuestionHeadings at :453. That
 * discriminator's colon is load-bearing (see comment at :453).
 *
 * Grammar accepted (all line-anchored):
 *   [heading] [**]Q<n>[**]              (colon-less — heading REQUIRED, Q2→A)
 *   [heading] [**]Q<n>[**]:             (colon — heading optional; bare Q<n>: OK)
 */
const QN_OPENER_PATTERN =
  '(?:^|\\n)(?:(?:#{1,6}\\s+(?:\\*\\*)?Q(\\d+)(?:\\*\\*)?(?::\\s*(.*))?)|(?:(?:\\*\\*)?Q(\\d+)(?:\\*\\*)?:\\s*(.*)))';
```

Note the disjunction is deliberate: colon-less arm requires a heading prefix; colon-bearing arm accepts either heading-prefixed or bare `Q<n>:`. This is the Q2→A shape and matches the byte-locked cockpit heading (`### Q<n>`) exactly.

Because the shared string is composed into three different `RegExp` instances (each with different trailing lookahead / trailing content), it is stored as a raw pattern string, not a `RegExp` — the callers instantiate with the appropriate flags and suffix.

**Capture-group note**: the disjunction produces **two alternate captures** for the Q number and trailing text. Consumers use whichever alternative matched (`match[1] ?? match[3]` for Q number, `match[2] ?? match[4]` for topic-or-answer). A tiny `pickQnMatch(match)` helper in the same file keeps the two call sites (opener parsing) clean.

### Outer regex (`parseAnswersFromComments`) rewrite

Current (`:457-458`):

```ts
const regex =
  /(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs;
```

New:

```ts
// Opener composed from QN_OPENER_PATTERN, then non-greedy body, then a
// terminator lookahead composed from QN_OPENER_PATTERN's NEXT-opener form
// (leading `\n` required in the lookahead so we can't re-anchor mid-line).
const QN_TERMINATOR_LOOKAHEAD =
  `(?=(?:\\n(?:(?:#{1,6}\\s+(?:\\*\\*)?Q\\d+(?:\\*\\*)?(?::.*)?)` +
  `|(?:(?:\\*\\*)?Q\\d+(?:\\*\\*)?:.*)))|$)`;

const regex = new RegExp(
  `${QN_OPENER_PATTERN}(.*?)${QN_TERMINATOR_LOOKAHEAD}`,
  'gs',
);
```

Body capture-group index shifts to `match[5]` (after the two Q-number and two topic-or-answer alternates from the opener disjunction). Documented inline where consumed.

### `extractEmbeddedAnswer` new arm

Current (`:406-420`) has two arms. Add a third **before** the current two so the more-specific `**Answer:** value` pattern wins over the more-permissive `**Answer**: value` on cockpit bodies where both could theoretically match:

```ts
// Format: **Answer:** value  (cockpit dialect — colon INSIDE the bold)
const m0 = text.match(/\*\*Answer:\*\*\s*(.+?)$/m);
if (m0) {
  let answer = m0[1]!.trim();
  // Q1→B: if a **Rationale:** line follows on a subsequent line inside the
  // same captured Q block, join it onto the answer so clarifications.md
  // preserves the *why*.
  const r = text.match(/\n\*\*Rationale:\*\*\s*(.+?)$/m);
  if (r) answer = `${answer}\nRationale: ${r[1]!.trim()}`;
  return answer;
}

// Existing arms (unchanged) ...
const m1 = text.match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);
if (m1) return (m1[1]! + m1[2]!).trim();

const m2 = text.match(/\*\*Answer\*\*:\s*(.+)$/m);
if (m2) return m2[1]!.trim();

return undefined;
```

**Ordering matters**: `m0`'s pattern is strictly more specific (`**Answer:**` — closing `**` right after the colon) than `m1`'s (`**Answer:...**` — closing `**` anywhere after the colon). On a body where both would greedily match, `m0` produces the intended cockpit-shaped extraction. On a body that only matches `m1` (engine dialect: `**Answer: A** — description`), `m0`'s `(.+?)$` won't match because the immediate `**` is followed by text on the same line, and `$` anchors line-end.

**Rationale placement precondition**: the `**Rationale:**` capture only runs inside the `m0` branch. The engine dialect never emits a `**Rationale:**` line, so `m1`/`m2` paths are unchanged and no regression risk to those consumers.

### FR-004 discriminator (`:453`) — do not touch, but comment

```ts
// FR-004 discriminator (Q5→C): the colon here is DELIBERATE. It separates
// engine-authored question comments (`### Q1: Topic`) from cockpit
// answer-block delimiters (`### Q1` — no colon). Removing the colon or
// folding this pattern into QN_OPENER_PATTERN would cause
// TRANSITION_WITH_QUESTION_HEADINGS to fire on every legitimate cockpit
// integration — a 100%-rate false positive. Keep colon-required.
const sourceHadQuestionHeadings = /(?:^|\n)###\s+Q\d+:/.test(comment.body);
```

### `commentMatchesAnswerPattern` (`:97-99`) rewrite

Current:

```ts
function commentMatchesAnswerPattern(body: string): boolean {
  return /(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:\s*.+/.test(body);
}
```

New:

```ts
function commentMatchesAnswerPattern(body: string): boolean {
  // Shared opener; drop capture groups by rewriting numeric-capture parens
  // as non-capturing. Non-capturing form kept as a second constant so the
  // outer parser's numeric captures are preserved.
  return new RegExp(QN_OPENER_PATTERN_NONCAPTURING).test(body);
}
```

`QN_OPENER_PATTERN_NONCAPTURING` is derived by replacing the two `(\d+)` captures in `QN_OPENER_PATTERN` with `(?:\d+)`. Both constants are declared adjacently with a short JSDoc explaining why two shapes exist.

### Write-back pattern (`:730-732`) — verify unchanged

The write-back replaces `*Pending*` inside `### Q<n>:` sections of `clarifications.md`. The file itself uses the engine dialect (`### Q1: Topic\n**Answer**: *Pending*`) written by `formatComment` at `:341`. Confirm during implementation that no cockpit-shaped section ever reaches this write-back path (it can't — this writes to the on-disk file, not to comment bodies). No change expected.

### Test fixtures

Add fixtures under `packages/orchestrator/src/worker/__tests__/`:

- **`FIXTURE_COCKPIT_MULTI`** — captured verbatim from a real cockpit-posted issue comment on a public Generacy issue (Q4→A MUST). This is #949's own cockpit-format answer body (or a similar known-good multi-question cockpit comment on a related issue if #949's Q1 was corrupted by the persistence bug independent of this fix). Must contain ≥ 2 `### Q<n>` blocks.
- **`FIXTURE_COCKPIT_SINGLE`** — a single-block cockpit body (SC-002-adjacent regression).
- **`FIXTURE_ENGINE_HEADING`** — `### Q1: Topic\n**Answer: A** — text`, existing dialect.
- **`FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE`** — `### Q1: Topic\n**Answer**: A`, existing dialect.
- **`FIXTURE_BARE_HUMAN`** — `Q1: answer text`, existing dialect.
- **`FIXTURE_MID_PROSE`** — `as per Q1: yes`, FR-005 negative regression.
- **`FIXTURE_BARE_LINE_START_NO_HEADING`** — `Q1\n**Answer:** X`, Q2→A negative regression (colon-less form requires heading).
- **`FIXTURE_LEAKED_QUESTION`** — cockpit-shaped opener but body contains `**Question**:`, FR-002 skip.

### Note on issue #949 Q1 answer corruption

The Q1 answer as persisted in `specs/949-summary-cockpit-plugin-posts/clarifications.md:17` is:

> `** A — Use the sealed file backend\nRationale:** It avoids a cloud round-trip.\n`

This is corrupted by `clarification-poster.ts:730-732`'s regex-replace consuming stray `**` inside the answer body — a separate bug that IS visible here but is unrelated to this issue's fix. The operator's option-B intent is unambiguous from the option text ("The `**Answer:** …` value plus the immediately following `**Rationale:** …` line, joined"). We implement Q1→B per that intent.

Whether to file the write-back corruption as a follow-up is a separate decision; per spec §"Notes / out of scope", we prefer one-issue-per-drift. Note it in the closing report but do not fix it here.

### Failure modes and observability

- **Regex compilation failure**: `QN_OPENER_PATTERN` is a compile-time constant string — a bad pattern surfaces at module load, not at request time. Startup fails loudly; caught by the existing test suite before ship.
- **`extractEmbeddedAnswer` returns `undefined`** on unrecognized shapes: existing behavior. Outer regex still captures the block; `parseAnswersFromComments`'s existing branch treats the untrimmed captured text as the answer, which for an unrecognized cockpit-adjacent shape yields multi-line garbage. This is the *current* behavior for engine-dialect non-heading forms and is preserved by design; the new `m0` arm shrinks the failure surface, not widens it.
- **FR-002 content sniff**: unchanged — after `extractEmbeddedAnswer` reduces the answer to a single line, the `**Question**:` / `**Context**:` check still fires if leaked question markup ends up in the extracted string.
- **FR-004 negative pin**: new test asserts `logger.warn` is NOT called with `code: 'TRANSITION_WITH_QUESTION_HEADINGS'` on a well-formed cockpit body. This is the load-bearing negative surface for Q5→C.

## Acceptance mapping to spec

| Spec acceptance | Implementation |
|---|---|
| Integrates cockpit `### Q<n>` + `**Answer:** X` | New `m0` arm in `extractEmbeddedAnswer` + widened opener/terminator via `QN_OPENER_PATTERN` |
| Multi-question ≥ 2 blocks integrates independently | Terminator lookahead widened in lockstep with opener; regression `FIXTURE_COCKPIT_MULTI` |
| Three pre-existing dialects still parse | `QN_OPENER_PATTERN` includes colon-bearing arm; `extractEmbeddedAnswer` m1/m2 arms unchanged |
| FR-005 line anchoring unchanged; bare `Q1\n…` no heading no colon does NOT open | `QN_OPENER_PATTERN` requires heading in colon-less arm (Q2→A); `FIXTURE_MID_PROSE` + `FIXTURE_BARE_LINE_START_NO_HEADING` negative regressions |
| FR-013 untrusted-author explainer fires for cockpit format | `commentMatchesAnswerPattern` uses `QN_OPENER_PATTERN_NONCAPTURING` |
| One shared constant; `:453` explicitly out of scope with code comment | `QN_OPENER_PATTERN` / `QN_OPENER_PATTERN_NONCAPTURING` extracted; `:453` gets a dedicated multi-line comment recording the exclusion |
| FR-004 negative pin for cockpit bodies | New test asserts absence of `TRANSITION_WITH_QUESTION_HEADINGS` on a well-formed cockpit body |
| Real cockpit fixture, ≥ 2 blocks | `FIXTURE_COCKPIT_MULTI` captured verbatim from #949 (or similar real issue) with ≥ 2 blocks |

## Out of scope

- **Cockpit posted format changes** — locked byte-exact by `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md`.
- **Write-back `**` consumption bug** in `clarification-poster.ts:730-732` (see Note above) — file separately if the operator wants it fixed.
- **`cockpit_advance` validates nothing** (spec §"Notes / out of scope") — separate issue.
- **`no-open-clarifications` typed error missing** — belongs in `agency` repo playbook, needs its own issue there per one-issue-per-repo convention.
- **FR-004 shared-constant sweep at `:453`** — Q5→C explicitly excludes it.
- **Any change to `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`** — the LLM path continues to be the primary channel; the deterministic parser is documented as the backstop only.

## Changeset

This diff touches `packages/orchestrator/src/` non-test files, so per `CLAUDE.md` the PR MUST add a new `.changeset/*.md` file:

- File: `.changeset/949-cockpit-answer-parser.md`
- Bump level: `patch` — this is a defect fix (`workflow:speckit-bugfix`); no new public export from `@generacy-ai/orchestrator` (regex constants stay internal).
- Package listed: `@generacy-ai/orchestrator`.

The changeset MUST be a newly-added file per the CI gate at `.github/workflows/changeset-bot.yml`.

## Next step

Run `/speckit:tasks` to generate the task list (T001..T00N) from this plan.
