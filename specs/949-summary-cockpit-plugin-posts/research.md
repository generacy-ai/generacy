# Research: Widen the deterministic clarification-answer parser to accept the cockpit dialect

**Feature**: #949 · **Branch**: `949-summary-cockpit-plugin-posts`

## Decision 1 — Fix side: parser widens, cockpit body stays byte-locked

**Chosen**: Widen `packages/orchestrator/src/worker/clarification-poster.ts` regex to accept both dialects. Cockpit posted format is untouched.

**Rationale**:
- The cockpit posted format (`### Q<n>\n**Answer:** X\n**Rationale:** Y`) is locked byte-exact by contract `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md` and referenced from two shipped playbooks (`agency/packages/claude-plugin-cockpit/commands/clarify.md:69-71`, `auto.md:273`). Changing it would break the LLM resume path in `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:94` that today reads it correctly.
- The engine parser has no cross-repo consumers; it's an internal safety net. Widening it is local, testable, and reversible.

**Alternatives considered**:
- **Change the cockpit format to emit engine dialect (`### Q<n>: Topic\n**Answer: X**`)** — Rejected. Would require synchronized rollout of an agency-repo change with an orchestrator-repo change; cockpit-posted comments already in flight on active issues would be caught mid-transition.
- **Change both** — Rejected. Same coordination cost, no gain.
- **Do nothing; rely on the LLM resume path** — Rejected. The deterministic parser is the documented backstop when the LLM/CLI fails to persist answers; silently disabling the backstop while claiming it exists is worse than the current visible bug in `clarifications.md`'s Q1 answer at `specs/949-summary-cockpit-plugin-posts/clarifications.md:17`.

**Source**: spec.md §"Proposed fix", clarification Q3.

## Decision 2 — Extract a single shared opener constant (Q3→A: MUST)

**Chosen**: Extract `QN_OPENER_PATTERN` (raw pattern string) plus `QN_OPENER_PATTERN_NONCAPTURING` (numeric-capture parens rewritten to non-capturing). Compose into three sites: outer opener at `:457-458`, outer terminator lookahead at `:457-458`, `commentMatchesAnswerPattern` at `:97-99`.

**Rationale** (from clarification Q3):
- The defect class under repair *is* pattern drift. Two duplicate synchronized copies are the failure mode being fixed.
- Extraction is mechanically cheap here (single-file, three sites) — the "awkward coupling" escape hatch for a SHOULD does not apply on these facts.
- The terminator lookahead is the site most likely to be missed if left as SHOULD; it is the one site the spec never named until clarification Q2, and missing it silently swallows every question after the first.

**Alternatives considered**:
- **SHOULD, with cross-referencing comment** — Rejected per Q3→A. Reviewer would have latitude to accept two synchronized copies.
- **Extract as `RegExp` not string** — Rejected. The three sites need different suffixes (opener has trailing body capture, terminator has trailing lookahead, `commentMatchesAnswerPattern` has trailing `.+`), and the outer regex composes both opener AND terminator into a single `RegExp`. String composition is cleanest.

**Explicit exclusion** (Q5→C): `sourceHadQuestionHeadings` at `:453` (`/(?:^|\n)###\s+Q\d+:/`) is NOT part of the shared constant. Its colon is the FR-004 discriminator between engine questions and cockpit answers.

## Decision 3 — Colon-less opener requires a heading (Q2→A)

**Chosen**: The colon-less arm of `QN_OPENER_PATTERN` requires a markdown heading prefix (`### Q<n>`, `## Q<n>`, `#### Q<n>`, etc.). Bare line-start `Q1\n**Answer:** X` (no heading, no colon) does NOT open a block. Colon-bearing arm (`Q1:`, `**Q1**:`, `### Q1: Topic`) continues to open as today.

**Rationale** (from clarification Q2):
- Cockpit itself always emits `### Q<n>` (heading present) — Option A covers the byte-locked shape exactly and nothing more.
- Option B (any line-anchored `Q<n>`) would promote bare `Q1 is the concern here` prose into an opener, weakening FR-005 line anchoring.
- Option C (heading OR bold-wrapped `**Q1**`) buys surface area with no coverage gain — no cockpit or engine dialect emits bold-wrapped colon-less openers.

## Decision 4 — Widen the terminator lookahead in lockstep (Q2→A addendum)

**Chosen**: The outer regex's terminator lookahead must widen at the same lines as the opener (`:457-458`), using the same grammar.

**Rationale**:
- Empirically verified against a real 2-question cockpit body: opener-only widening yields 1 block (Q1 lazy `(.*?)` runs to `$` and swallows Q2); opener + terminator widening yields 2.
- Cockpit **batches** answers — multi-question is the normal case, not an edge. A fix that misses this quietly regresses every batch to a single-answer capture.
- The multi-question test fixture is therefore load-bearing: single-question fixtures go green with the primary defect live.

## Decision 5 — Rationale-line included in captured answer (Q1→B, corrected)

**Chosen**: When a cockpit block has both `**Answer:** …` and a following `**Rationale:** …`, the captured answer is `"<answer-value>\nRationale: <rationale-value>"`. The existing single-string `ParsedAnswer.answer` shape is preserved.

**Rationale**:
- The Q1 clarification answer in `specs/949-summary-cockpit-plugin-posts/clarifications.md:17` is visibly corrupted at the persistence layer (regex-replace consumed stray `**`) — but the operator's intent is unambiguous from the option-B text: "The `**Answer:** …` value plus the immediately following `**Rationale:** …` line, joined (e.g., `A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.`). Preserves reasoning in the persisted record."
- Option A (answer-line only) would drop reasoning that operators reading persisted answers later would benefit from.
- Option C (whole Q block verbatim) would put multi-line markup into `clarifications.md`, breaking the write-back regex at `:730-732`.
- Encoding the join as a `\n`-delimited string preserves `ParsedAnswer.answer: string` — no schema bump, no downstream consumer needs a change.

## Decision 6 — Real cockpit-posted fixture, multi-question (Q4→A)

**Chosen**: At least one test fixture MUST be captured verbatim from a real cockpit-posted issue comment AND MUST be multi-question (≥ 2 `### Q<n>` blocks).

**Rationale** (from clarification Q4):
- A hand-written fixture pins the implementer's *reading* of the byte-locked contract rather than the contract itself. An implementer who misreads `**Answer:**` as `**Answer**:` writes a fixture that agrees with their own error and goes green. A captured body cannot make that mistake.
- Multi-question is load-bearing per Decision 4 above: a single-question fixture passes even with the terminator bug live.
- Issue #949's own cockpit-format answer body satisfies the "real" requirement (available at hand). If #949's fixture is judged compromised by the Q1 write-back corruption bug (which is a persistence-layer issue independent of what cockpit *posts*), any of the other cockpit-integrated issues in the recent tree can serve as a substitute.

## Decision 7 — FR-004 negative pin, not positive (Q5→C)

**Chosen**: Add a regression test asserting that a well-formed cockpit answer comment integrates WITHOUT emitting `TRANSITION_WITH_QUESTION_HEADINGS`. Keep `:453`'s pattern colon-required and explicitly outside the shared constant. Add a code comment at `:453` recording that the colon is deliberate.

**Rationale** (from clarification Q5):
- A cockpit answer comment uses `### Q<n>` as answer-block delimiters, not question headings. Firing "possible bot self-answer" on every legitimate cockpit integration would be a 100%-rate false positive — a guard that always fires is dead in the same way the guard being repaired is dead.
- The colon in `:453` is what currently discriminates engine-authored questions (`### Q1: Topic`) from cockpit answer delimiters (`### Q1`). Removing it would break FR-004.
- Correcting the spec's Impact §3 wording: FR-004 does not fire today because *no answers integrate at all*; after the fix it still will not fire on cockpit bodies — that is correct behavior, not a remaining gap.

## Decision 8 — Order `extractEmbeddedAnswer` arms with cockpit-specific first

**Chosen**: Add the new `**Answer:** value` arm (`m0`) *before* the existing `**Answer: value**` (`m1`) and `**Answer**: value` (`m2`) arms.

**Rationale**:
- `m1`'s pattern (`\*\*Answer:\s*(.+?)\*\*(.*)$`) is greedy on the value-inside-bold form. On a cockpit body `**Answer:** A — text`, `m1` COULD match with the captured value being empty (`(.+?)` is lazy but matches the empty run to the `**` immediately after). Placing `m0` first eliminates this ambiguity.
- `m0`'s pattern (`\*\*Answer:\*\*\s*(.+?)$`) requires the closing `**` immediately after the colon. On an engine-dialect body `**Answer: A** — text` (colon inside bold, text after), `m0` cannot match because the character after `:` is a space or letter, not `*`. Ordering is safe against engine-dialect regression.

## Sources

- `packages/orchestrator/src/worker/clarification-poster.ts` (target module).
- `agency/packages/claude-plugin-cockpit/commands/clarify.md:69-71` (cockpit posted format — locked).
- `agency/packages/claude-plugin-cockpit/commands/auto.md:273` (cockpit auto-mode posted format — locked).
- `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md` (byte-lock contract).
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:94` (LLM resume path — reads the cockpit body correctly today).
- `packages/orchestrator/src/worker/phase-loop.ts:745-746` (gate call site for `integrateClarificationAnswers`).
- `packages/orchestrator/src/worker/phase-resolver.ts:10` (`completed:clarification` re-runs clarify).
- Spec §"Root cause", §"Impact", §"Proposed fix", §"Tests", §"Acceptance criteria".
- Clarifications Q1..Q5 in `clarifications.md`.
