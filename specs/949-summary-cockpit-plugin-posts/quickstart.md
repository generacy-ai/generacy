# Quickstart: Widen the deterministic clarification-answer parser to accept the cockpit dialect

**Feature**: #949 · **Branch**: `949-summary-cockpit-plugin-posts`

## What this fixes

Cockpit posts clarification answers as:

```
<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — Use the sealed file backend
**Rationale:** It avoids a cloud round-trip.
```

The engine's deterministic `parseAnswersFromComments` reads that as **zero answers** because three regex misses stack. This fix widens the parser to accept the cockpit dialect while keeping the engine/human dialect working. The cockpit posted format is not touched (locked byte-exact by contract).

## Reproduce the bug (before the fix)

```bash
cd /workspaces/generacy
pnpm install
```

In a REPL or throwaway script:

```js
const body = "<!-- generacy-cockpit:clarification-answers -->\n\n### Q1\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.\n\n### Q2\n**Answer:** B\n**Rationale:** Because.\n";
const outer = /(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs;
[...body.matchAll(outer)].length;                          // => 0
"**Answer:** A".match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);     // => null
"**Answer:** A".match(/\*\*Answer\*\*:\s*(.+)$/m);          // => null
```

## Files touched

- **Modified**: `packages/orchestrator/src/worker/clarification-poster.ts`
- **Modified**: `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`
- **Added**: `.changeset/949-cockpit-answer-parser.md` (required by CI gate — see below)

Zero new files under `src/`. Zero new dependencies.

## Development workflow

### 1. Run the affected test suite

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/orchestrator test -- clarification-poster
```

### 2. Iterate

Add fixtures per `contracts/regex-contract.md`. The fixture set is enumerated in `data-model.md` §"Fixture inventory".

**Load-bearing fixtures** (a passing test suite that omits these does not prove the fix):
- `FIXTURE_COCKPIT_MULTI` — ≥ 2 `### Q<n>` blocks, captured verbatim from a real cockpit-posted issue comment. See "Getting a real fixture" below.
- `FIXTURE_MID_PROSE` — FR-005 line-anchoring negative regression.
- `FIXTURE_BARE_LINE_START_NO_HEADING` — Q2→A negative regression (colon-less form requires heading).
- FR-004 negative pin — well-formed cockpit body integrates WITHOUT `TRANSITION_WITH_QUESTION_HEADINGS` warning.

### 3. Run the full orchestrator test suite before pushing

```bash
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/orchestrator typecheck
```

### 4. Add the changeset (mandatory — CI gate)

Per `CLAUDE.md` §"Changesets", any diff touching a non-test file under `packages/*/src/` MUST add a new `.changeset/*.md` file, or CI fails:

> ::error::This PR modifies packages/*/src/ but adds no changeset.

For this fix:

```bash
pnpm changeset
# choose @generacy-ai/orchestrator, bump level: patch
# summary: "Widen clarification-answer parser to accept cockpit dialect (#949)"
```

Or hand-write `.changeset/949-cockpit-answer-parser.md`:

```md
---
'@generacy-ai/orchestrator': patch
---

Widen the deterministic clarification-answer parser (`parseAnswersFromComments`) to
accept the cockpit-plugin dialect (`### Q<n>` + `**Answer:** X`) in addition to the
existing engine/human dialects. Fixes silent no-op backstop for cockpit-posted answers
and re-enables the FR-013 untrusted-answer explainer for the cockpit shape. (#949)
```

Bump level rationale: `patch` — defect fix (`workflow:speckit-bugfix`); no new public
export (regex constants stay internal).

### 5. Commit and push

Speckit workflow will pick it up from there.

## Getting a real fixture (Q4→A MUST)

Issue #949's own cockpit-format answer body satisfies "captured verbatim from a real
cockpit-posted issue comment." Fetch it via `gh`:

```bash
gh api repos/generacy-ai/generacy/issues/949/comments \
  --jq '.[] | select(.body | contains("generacy-cockpit:clarification-answers")) | .body' \
  > /tmp/949-cockpit-body.txt
```

Copy the body into the test file as a template literal. Confirm it contains ≥ 2
`### Q<n>` blocks. If it doesn't (or if the operator's Q1 answer looks corrupted by
the persistence bug at `:730-732`), fetch a substitute from any recent Generacy issue
that saw cockpit clarification traffic — grep across issues #920–#950 with the same
`generacy-cockpit:clarification-answers` marker filter.

## Available commands

- `pnpm --filter @generacy-ai/orchestrator test -- clarification-poster` — run only the
  affected test suite.
- `pnpm --filter @generacy-ai/orchestrator test` — full orchestrator suite.
- `pnpm --filter @generacy-ai/orchestrator typecheck` — TS typecheck.
- `pnpm changeset status` — verify the changeset file is present (reads the directory,
  not git; works pre-commit).
- `pnpm changeset` — interactive changeset scaffolder.

## Troubleshooting

- **CI: "This PR modifies packages/*/src/ but adds no changeset"** — you forgot the
  `.changeset/*.md` file. See step 4 above.
- **Only some Q blocks in a multi-question fixture integrate** — you widened the
  outer opener but not the terminator lookahead. Both live at `:457-458`; they MUST
  change together. See `plan.md` §Design "Outer regex rewrite" and `contracts/regex-contract.md`
  invariant 2.
- **FR-004 `TRANSITION_WITH_QUESTION_HEADINGS` fires on a legitimate cockpit answer** —
  you accidentally folded `sourceHadQuestionHeadings` at `:453` into the shared constant.
  Revert that; the colon there is deliberate (Q5→C). See `plan.md` §Design "FR-004
  discriminator".
- **Mid-prose `as per Q1: yes` is now capturing** — you dropped the `(?:^|\n)`
  line-anchor from `QN_OPENER_PATTERN`. FR-005 regression. See `data-model.md`
  invariant 4.
- **Bare `Q1\n**Answer:** X` (no heading) now opens a block** — the colon-less arm
  of `QN_OPENER_PATTERN` is missing its `#{1,6}\s+` heading requirement. Q2→A
  regression.
- **Engine dialect `### Q1: Topic\n**Answer: A** — text` regresses** — `extractEmbeddedAnswer`'s
  arm ordering wrong, or the m0 pattern is over-greedy. See `plan.md` §Design
  "`extractEmbeddedAnswer` new arm" and `research.md` decision 8.

## Next step

After `/plan`, run `/speckit:tasks` to generate the T-numbered task list from this plan.
