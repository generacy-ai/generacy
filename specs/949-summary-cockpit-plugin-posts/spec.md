# Feature Specification: Cockpit clarification answers unparseable by engine's deterministic answer-scanner

**Branch**: `949-summary-cockpit-plugin-posts` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

The cockpit plugin posts clarification answers in a body shape that the orchestrator's deterministic answer parser cannot read. `parseAnswersFromComments` finds **zero** answers in a cockpit-posted comment and `integrateClarificationAnswers` bails with `{ integrated: 0, reason: 'no-answers' }` — indistinguishable from "the operator never answered".

Nothing is visibly broken end-to-end today, because the LLM resume path reads the comment fine (see **Impact**). But the module whose documented job is to be the safety net *when the agent/CLI fails to persist answers* is silently dead for every cockpit-posted answer, and two of its guard features never fire.

The mismatch is a **double miss** — the heading and the answer line each fail independently, so fixing either one alone changes nothing.

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
3. **FR-004 residual-race detector never fires** — gated behind the same patterns.

The failure is silent in the worst way: `reason: 'no-answers'` is exactly what a genuinely unanswered issue produces.

## Proposed fix

Widen the **engine parser** to accept the cockpit dialect. Do *not* change the cockpit's posted format — that shape is locked byte-exact across shipped specs/contracts in `agency`, and the LLM resume path already depends on it working.

1. **Make the colon optional in the heading opener** at [`:457-458`](packages/orchestrator/src/worker/clarification-poster.ts#L457-L458) so `### Q1` and `### Q1: Topic` both open a block. Keep the line anchoring (FR-005) — mid-prose `as per Q1: yes` must still not capture.
2. **Add `**Answer:** value` as a third accepted form** in [`extractEmbeddedAnswer`](packages/orchestrator/src/worker/clarification-poster.ts#L406-L420), alongside the existing `**Answer: X**` and `**Answer**: X`.
3. **Keep `commentMatchesAnswerPattern` (`:97-99`) in lockstep** with the widened opener, so the FR-013 explainer fires for cockpit-shaped answers too. These two patterns drifting is the root of impact #2 — consider extracting one shared pattern constant rather than maintaining two copies.
4. **Check the write-back pattern** at [`:730-732`](packages/orchestrator/src/worker/clarification-poster.ts#L730-L732) (``` `### Q${n}:[\s\S]*?\*\*Answer\*\*:\s*\*Pending\*` ```). This one targets `clarifications.md`, which *does* use the `### Q1:` / `**Answer**: *Pending*` dialect, so it is internally consistent and likely needs no change — but it should be confirmed once the opener widens, not assumed.
5. **Preserve the FR-002 content sniff** (`**Question**:` / `**Context**:` → skip as leaked bot question body). Widening the opener must not weaken that guard — the cockpit answer comment carries neither label, so it should pass cleanly.

### Tests

Pin **both dialects** so they can't drift apart again:

- Cockpit dialect: `### Q<n>` + `**Answer:** X` (+ a `**Rationale:** …` line following) → integrates.
- Engine/human dialect: `### Q<n>: Topic` + `**Answer: X**`, and `**Answer**: X` → still integrates (regression).
- Bare human dialect: `Q1: answer text` → still integrates (regression).
- Mid-prose `as per Q1: yes` → still does **not** capture (FR-005 regression).
- A cockpit-format answer from an untrusted author → produces an explainer comment (FR-013).

A fixture built from a real cockpit-posted comment body would be worth more than a hand-written string here.

## Acceptance criteria

- `integrateClarificationAnswers` integrates answers from a cockpit-posted `<!-- generacy-cockpit:clarification-answers -->` comment (`### Q<n>` + `**Answer:** X`), rather than returning `reason: 'no-answers'`.
- All three pre-existing dialects continue to parse; FR-005 line-anchoring and the FR-002 content sniff are unchanged.
- The FR-013 untrusted-answer explainer fires for a cockpit-format answer from an untrusted author.
- Tests pin every dialect above, so a future format change on either side fails loudly instead of silently no-opping.

## Notes / out of scope

Two adjacent drifts surfaced during this investigation. Both are separate and **not** part of this issue:

- **`cockpit_advance` validates nothing.** `runAdvance` ([`packages/generacy/src/cli/commands/cockpit/advance.ts:73-181`](packages/generacy/src/cli/commands/cockpit/advance.ts#L73-L181)) only inspects labels — it never reads comments. `gate="clarification"` succeeds on an issue where zero answers were posted. "Every question must be answered before advancing" exists only as playbook prose (`agency` `clarify.md:81`), agent-enforced rather than engine-enforced. Possibly by design; worth a decision either way.
- **The `no-open-clarifications` typed error does not exist.** The cockpit playbook (`agency` `clarify.md:26`) instructs the agent to handle it and exit zero, but it is absent from the `ErrorClass` union in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. The real signal is `status: 'ok'` with `clarificationComment: null`. An agent following the playbook literally would never hit its early-exit branch and would fall through trying to parse `null.body`. Fix belongs in `agency` (playbook), so it needs its own issue in that repo per our one-issue-per-repo convention.


## User Stories

### US1: Deterministic safety net catches cockpit answers when the LLM path fails

**As a** speckit workflow operator using the cockpit plugin,
**I want** `integrateClarificationAnswers` to parse the cockpit's `### Q<n>` + `**Answer:** X` comment shape,
**So that** the deterministic backstop actually catches a missed-persist even when the LLM resume path silently drops the answers.

**Acceptance Criteria**:
- [ ] A `<!-- generacy-cockpit:clarification-answers -->` comment body of the shape `### Q1\n**Answer:** A — …\n**Rationale:** …` yields `integrated: N > 0` (not `reason: 'no-answers'`).
- [ ] The three pre-existing dialects (`### Q<n>: Topic` + `**Answer: X**`, `**Answer**: X`, and bare `Q1: text`) continue to integrate unchanged.
- [ ] Mid-prose `as per Q1: yes` still does **not** capture (FR-005 line-anchoring preserved).
- [ ] The FR-002 content sniff (skip comments that carry leaked `**Question**:`/`**Context**:` labels) continues to fire.

### US2: Operator receives an explainer when an untrusted author posts a cockpit-shaped answer

**As a** repo maintainer,
**I want** the FR-013 explainer comment to fire when an untrusted GitHub user posts an answer in the cockpit dialect,
**So that** they get feedback that the answer was ignored (and why), instead of silent no-op.

**Acceptance Criteria**:
- [ ] An untrusted-author comment matching `### Q<n>` + `**Answer:** X` triggers the FR-013 explainer.
- [ ] `commentMatchesAnswerPattern` stays in lockstep with the outer opener regex — extracting a shared pattern constant is preferred over maintaining two drifting copies.

### US3: Dialects are pinned by tests so the two sides can't silently drift again

**As a** future contributor changing either the engine parser or the cockpit's posted shape,
**I want** every accepted dialect covered by a regression test with a real cockpit-body fixture,
**So that** a format change on either side fails loudly in CI instead of silently no-opping in production.

**Acceptance Criteria**:
- [ ] Test fixtures cover: cockpit dialect, engine/human dialect (both `**Answer: X**` and `**Answer**: X`), bare human dialect, mid-prose non-capture, and untrusted-author explainer path.
- [ ] At least one fixture is captured from a real cockpit-posted comment body rather than hand-written.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The outer heading regex in `packages/orchestrator/src/worker/clarification-poster.ts:457-458` MUST accept `### Q<n>` (no colon) as an answer-block opener, in addition to `### Q<n>: <topic>`. | P1 | Widening only — line-anchoring (FR-005) must be preserved. |
| FR-002 | `extractEmbeddedAnswer` (`:406-420`) MUST accept `**Answer:** value` as a third form, alongside the existing `**Answer: X**` and `**Answer**: X`. | P1 | Cockpit posts `**Answer:** A` — colon inside the bold, closing `**` immediately after. |
| FR-003 | `commentMatchesAnswerPattern` (`:97-99`) MUST recognize the cockpit-shaped answer so the FR-013 untrusted-author explainer fires. | P1 | Prefer a shared pattern constant over two copies. |
| FR-004 | The FR-005 line-anchoring guard MUST remain intact — mid-prose `as per Q1: yes` MUST NOT capture. | P1 | Regression. |
| FR-005 | The FR-002 content sniff (`**Question**:`/`**Context**:` → skip as leaked bot question body) MUST continue to fire. | P1 | Regression. Cockpit answer comment carries neither label, so it passes cleanly. |
| FR-006 | The write-back pattern at `:730-732` (targets `clarifications.md`) MUST be confirmed still-correct after the opener widens (likely no change needed — file uses the `### Q1:` dialect). | P2 | Confirm, don't assume. |
| FR-007 | Test coverage MUST pin every accepted dialect plus the negative cases (mid-prose non-capture, untrusted-author explainer). | P1 | See US3. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cockpit-posted clarification answer comments integrate through `integrateClarificationAnswers`. | 100% of well-formed cockpit comments yield `integrated > 0`. | Unit test against real cockpit-body fixture. |
| SC-002 | No regression in the three pre-existing accepted dialects. | 3/3 dialects still integrate. | Regression unit tests. |
| SC-003 | FR-013 untrusted-author explainer fires on cockpit-shaped answers. | Explainer comment posted in the untrusted-author scenario. | Integration test asserting comment body. |
| SC-004 | No new false positives on the mid-prose non-capture case. | 0 spurious captures. | Regression unit test. |

## Assumptions

- The cockpit's posted answer body shape is byte-locked by `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md` and MUST NOT change as part of this fix. The engine parser widens to accept it.
- The write-back pattern at `clarification-poster.ts:730-732` operates against `clarifications.md`, which uses the internally-consistent `### Q<n>:` / `**Answer**: *Pending*` dialect and is not affected by the widened opener.
- Trusted-author determination is upstream of this fix and is unchanged.
- Fixture recorded from a real cockpit-posted comment body is available (or can be captured) for the test suite.

## Out of Scope

- **Changing the cockpit's posted format.** That shape is locked byte-exact in shipped `agency` specs/contracts and the LLM resume path already depends on it.
- **`cockpit_advance` label-only validation.** Separate drift surfaced during investigation: `runAdvance` never reads comments to enforce "every question answered before advancing". Deliberate or not, it needs its own decision — file separately if pursued.
- **The missing `no-open-clarifications` typed error.** Cockpit playbook (`agency` `clarify.md:26`) references a typed error absent from `ErrorClass` in `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. Fix belongs in the `agency` repo (playbook), per one-issue-per-repo convention.
- Changes to the LLM resume path (`packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`). It already works and is not the safety net under repair.

---

*Generated by speckit*
