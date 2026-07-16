# Feature Specification: ## Summary

The cockpit plugin posts clarification answers in a body shape that the orchestrator's deterministic answer parser cannot read

**Branch**: `949-summary-cockpit-plugin-posts` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

## Summary

The cockpit plugin posts clarification answers in a body shape that the orchestrator's deterministic answer parser cannot read. `parseAnswersFromComments` finds **zero** answers in a cockpit-posted comment and `integrateClarificationAnswers` bails with `{ integrated: 0, reason: 'no-answers' }` — indistinguishable from "the operator never answered".

Nothing is visibly broken end-to-end today, because the LLM resume path reads the comment fine (see **Impact**). But the module whose documented job is to be the safety net *when the agent/CLI fails to persist answers* is silently dead for every cockpit-posted answer, and two of its guard features never fire.

The mismatch is a **triple miss** — the opener heading, the terminator lookahead, and the `**Answer:**` line each fail independently, so fixing any one or two of them in isolation changes nothing (or worse: fixing only the opener yields a 2-question cockpit body that opens exactly **one** block, silently swallowing every question after the first).

## Root cause

Two dialects drifted apart. The engine authors questions as `### Q<n>: <topic>` and literally instructs humans to reply `Q1: your answer here` — [`packages/orchestrator/src/worker/clarification-poster.ts:341`](packages/orchestrator/src/worker/clarification-poster.ts#L341) and [`:359-362`](packages/orchestrator/src/worker/clarification-poster.ts#L359-L362). The parser was built for that dialect. The cockpit playbooks later standardized on a different one, and nothing enforced agreement.

**What the cockpit posts** (`agency/packages/claude-plugin-cockpit/commands/clarify.md:69-71`, `auto.md:273` — locked as byte-exact by `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md`):

```
<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — Use the sealed file backend
**Rationale:** It avoids a cloud round-trip.
```

**Miss 1 — heading.** The outer regex at [`clarification-poster.ts:457-458`](packages/orchestrator/src/worker/clarification-poster.ts#L457-L458) requires a **colon** after `Q<n>`:

```js
/(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs
```

The cockpit emits `### Q1` with no colon (the title lives in the engine's question comment, not the answer comment) → no match.

**Miss 2 — answer line.** [`extractEmbeddedAnswer` (`:406-420`)](packages/orchestrator/src/worker/clarification-poster.ts#L406-L420) accepts exactly two forms:

```js
const m1 = text.match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);   // **Answer: A** — text
const m2 = text.match(/\*\*Answer\*\*:\s*(.+)$/m);         // **Answer**: A
```

The cockpit emits `**Answer:** A` — colon *inside* the bold, closing `**` immediately after. Neither form matches.

**Miss 3 — terminator lookahead.** The outer regex's block terminator at [`:457-458`](packages/orchestrator/src/worker/clarification-poster.ts#L457-L458) — `(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)` — also requires a colon. Widening only the opener yields a 2-question cockpit body that opens **one** block: Q1's lazy `(.*?)` finds no colon-bearing next-opener, runs to `$`, and swallows Q2 verbatim. Because cockpit **batches** answers, multi-question is the normal case; a fix that misses this quietly regresses every batch to a single-answer capture.

### Reproduction

Both regexes run against the exact posted bodies:

| Body | Outer regex | `extractEmbeddedAnswer` |
|---|---|---|
| Cockpit: `### Q1` + `**Answer:** A — …` | **0 matches** | `undefined` |
| Engine/human: `### Q1: Topic` + `**Answer: A** — …` | 2 matches | `"A — Use the sealed file backend"` |

```js
const outer = () => /(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs;
const body = "<!-- generacy-cockpit:clarification-answers -->\n\n### Q1\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.\n";
[...body.matchAll(outer())].length;                          // => 0
"**Answer:** A".match(/\*\*Answer:\s*(.+?)\*\*(.*)$/m);      // => null
"**Answer:** A".match(/\*\*Answer\*\*:\s*(.+)$/m);           // => null
```

## Impact

**Why it looks fine.** `completed:clarification` resumes by re-running clarify ([`phase-resolver.ts:10`](packages/orchestrator/src/worker/phase-resolver.ts#L10)), and [`packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:94`](packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts#L94) hands raw trusted comment bodies to an LLM with *"find the developer's answer in the trusted comments block above"*. The model parses `**Answer:**` without trouble and writes `clarifications.md` itself. By the time the `on-questions` gate calls `integrateClarificationAnswers` ([`phase-loop.ts:745-746`](packages/orchestrator/src/worker/phase-loop.ts#L745-L746)), the file is already filled in, so the gate correctly stays closed and the no-op is invisible.

**An LLM is silently covering for a dead deterministic path.** Concretely, today:

1. **The safety net can't catch a persistence failure.** If the LLM/CLI ever fails to write the answers through, `integrateClarificationAnswers` is the documented backstop — and it returns `no-answers` for every cockpit comment.
2. **FR-013 untrusted-answer explainer never fires.** [`commentMatchesAnswerPattern` (`:97-99`)](packages/orchestrator/src/worker/clarification-poster.ts#L97-L99) uses the same colon-requiring pattern, so a cockpit-format answer from an untrusted author is dropped with **no explainer comment** — the operator gets zero feedback about why their answer was ignored.
3. **FR-004 residual-race detector is currently inert for cockpit bodies, but that is the intended post-fix state.** It does not fire today because no cockpit answers integrate at all. After this fix, it still will not fire on well-formed cockpit answer comments — and that is *correct behavior*, not a remaining gap. `sourceHadQuestionHeadings` at [`:453`](packages/orchestrator/src/worker/clarification-poster.ts#L453) uses a **colon-required** `/(?:^|\n)###\s+Q\d+:/` pattern precisely to discriminate engine-authored questions (`### Q1: Topic`) from cockpit answer delimiters (`### Q1` — no colon). Firing "possible bot self-answer" on every legitimate cockpit integration would be a 100%-rate false positive. This pattern is therefore **explicitly out of scope** for the shared-constant extraction under FR-003 (see clarifications Q3 and Q5).

The failure is silent in the worst way: `reason: 'no-answers'` is exactly what a genuinely unanswered issue produces.

## Proposed fix

Widen the **engine parser** to accept the cockpit dialect. Do *not* change the cockpit's posted format — that shape is locked byte-exact across shipped specs/contracts in `agency`, and the LLM resume path already depends on it working.

1. **Make the colon optional in the heading opener** at [`:457-458`](packages/orchestrator/src/worker/clarification-poster.ts#L457-L458) so `### Q1` and `### Q1: Topic` both open a block. Colon-less form REQUIRES a markdown heading prefix (`### Q<n>`, `## Q<n>`, `#### Q<n>`, etc.); bare line-anchored `Q1\n…` without a heading does NOT open a block (per clarification Q2). Keep the line anchoring (FR-005) — mid-prose `as per Q1: yes` must still not capture.
2. **Widen the block terminator lookahead in exact lockstep with the opener** at [`:457-458`](packages/orchestrator/src/worker/clarification-poster.ts#L457-L458). The terminator `(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)` currently requires a colon; if only the opener widens, a multi-question cockpit body opens exactly one block (Q1 swallows Q2…Qn to EOF). This is a first-class requirement, not incidental — cockpit answers are always batched.
3. **Add `**Answer:** value` as a third accepted form** in [`extractEmbeddedAnswer`](packages/orchestrator/src/worker/clarification-poster.ts#L406-L420), alongside the existing `**Answer: X**` and `**Answer**: X`.
4. **Extract a single shared opener pattern constant** (MUST, per clarification Q3). The shared fragment composes into **three** sites: (a) the outer regex opener, (b) the outer regex terminator lookahead (item 2 above), and (c) `commentMatchesAnswerPattern` (`:97-99`). Two duplicate copies fail acceptance. The shared constant MUST **exclude** [`:453`](packages/orchestrator/src/worker/clarification-poster.ts#L453)'s `sourceHadQuestionHeadings` pattern, whose colon is load-bearing (FR-004 discriminator; see Impact #3 and clarification Q5); add a code comment at `:453` recording that the colon is deliberate and what it discriminates.
5. **Check the write-back pattern** at [`:730-732`](packages/orchestrator/src/worker/clarification-poster.ts#L730-L732) (``` `### Q${n}:[\s\S]*?\*\*Answer\*\*:\s*\*Pending\*` ```). This one targets `clarifications.md`, which *does* use the `### Q1:` / `**Answer**: *Pending*` dialect, so it is internally consistent and likely needs no change — but it should be confirmed once the opener widens, not assumed.
6. **Preserve the FR-002 content sniff** (`**Question**:` / `**Context**:` → skip as leaked bot question body). Widening the opener must not weaken that guard — the cockpit answer comment carries neither label, so it should pass cleanly.

### Tests

Pin **both dialects** so they can't drift apart again:

- Cockpit dialect: `### Q<n>` + `**Answer:** X` (+ a `**Rationale:** …` line following) → integrates.
- **Multi-question cockpit dialect (≥ 2 blocks)** → each `### Q<n>` block integrates independently; no block swallows the next. This test is load-bearing: a single-Q fixture passes even with the terminator-lookahead bug (Miss 3) live, so it would let the primary defect through. This test MUST exist.
- Engine/human dialect: `### Q<n>: Topic` + `**Answer: X**`, and `**Answer**: X` → still integrates (regression).
- Bare human dialect: `Q1: answer text` → still integrates (regression).
- Mid-prose `as per Q1: yes` → still does **not** capture (FR-005 regression).
- Bare line-start `Q1\n**Answer:** X` (no heading, no colon) → still does **not** capture (per clarification Q2 — colon-less opener requires a heading).
- A cockpit-format answer from an untrusted author → produces an explainer comment (FR-013).
- **FR-004 negative test:** a well-formed cockpit answer comment integrates **without** emitting `TRANSITION_WITH_QUESTION_HEADINGS` (per clarification Q5 — firing on legitimate cockpit answers would be a 100%-rate false positive).

**Fixture requirement (MUST, per clarification Q4):** at least one test fixture MUST be captured verbatim from a real cockpit-posted issue comment (e.g., #949's own cockpit-format answer comment satisfies this) AND MUST be **multi-question** (≥ 2 `### Q<n>` blocks). A hand-modeled fixture is not acceptable — an implementer who misreads `**Answer:**` as `**Answer**:` will write a fixture that agrees with their own error and goes green. A captured real body cannot make that mistake.

## Acceptance criteria

- `integrateClarificationAnswers` integrates answers from a cockpit-posted `<!-- generacy-cockpit:clarification-answers -->` comment (`### Q<n>` + `**Answer:** X`), rather than returning `reason: 'no-answers'`.
- A **multi-question** (≥ 2 blocks) cockpit-posted comment integrates every block independently; no block swallows the next (Miss 3 fix).
- All three pre-existing dialects continue to parse; FR-005 line-anchoring and the FR-002 content sniff are unchanged. Bare line-start `Q1\n…` (no heading, no colon) does NOT open a block.
- The FR-013 untrusted-answer explainer fires for a cockpit-format answer from an untrusted author.
- A single shared opener pattern constant is extracted (MUST) and composed into the outer opener, outer terminator lookahead, and `commentMatchesAnswerPattern`. `sourceHadQuestionHeadings` at `:453` is explicitly out of scope and remains colon-required (with a code comment recording why).
- A well-formed cockpit answer comment integrates **without** emitting `TRANSITION_WITH_QUESTION_HEADINGS` (FR-004 negative pin).
- Tests include at least one fixture captured verbatim from a real cockpit-posted issue comment AND at least one multi-question fixture (either the same fixture or two), so a future format change on either side fails loudly instead of silently no-opping.

## Notes / out of scope

Two adjacent drifts surfaced during this investigation. Both are separate and **not** part of this issue:

- **`cockpit_advance` validates nothing.** `runAdvance` ([`packages/generacy/src/cli/commands/cockpit/advance.ts:73-181`](packages/generacy/src/cli/commands/cockpit/advance.ts#L73-L181)) only inspects labels — it never reads comments. `gate="clarification"` succeeds on an issue where zero answers were posted. "Every question must be answered before advancing" exists only as playbook prose (`agency` `clarify.md:81`), agent-enforced rather than engine-enforced. Possibly by design; worth a decision either way.
- **The `no-open-clarifications` typed error does not exist.** The cockpit playbook (`agency` `clarify.md:26`) instructs the agent to handle it and exit zero, but it is absent from the `ErrorClass` union in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. The real signal is `status: 'ok'` with `clarificationComment: null`. An agent following the playbook literally would never hit its early-exit branch and would fall through trying to parse `null.body`. Fix belongs in `agency` (playbook), so it needs its own issue in that repo per our one-issue-per-repo convention.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
