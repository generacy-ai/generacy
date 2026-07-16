# Clarifications: cockpit clarification answers are unparseable by the engine's deterministic answer-scanner

**Issue**: #949
**Branch**: `949-summary-cockpit-plugin-posts`

## Batch 1 — 2026-07-16T04:24:00Z

### Q1: Rationale-line inclusion in captured answer
**Context**: The cockpit body is `### Q1\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.\n`. The outer regex captures the whole Q block (until the next opener or EOF), then `extractEmbeddedAnswer` picks the answer text out. What ends up in `clarifications.md` for Q1 depends on whether the rationale line rides along or gets stripped. This is user-visible: it controls whether operators reading persisted answers later see the *why* or just the *what*, and it also controls whether the deterministic backstop faithfully reproduces what the LLM path already writes.
**Question**: When the deterministic parser integrates a cockpit-dialect answer, what content should end up as the Q<n> answer text in `clarifications.md`?
**Options**:
- A: Just the value on the `**Answer:** …` line (e.g., `"A — Use the sealed file backend"`). Rationale and any following lines are dropped. Matches the current `extractEmbeddedAnswer` shape (single string per Q) and stays consistent with the engine/human dialect where rationale isn't a first-class concept.
- B: The `**Answer:** …` value plus the immediately following `**Rationale:** …` line, joined (e.g., `"A — Use the sealed file backend\nRationale: It avoids a cloud round-trip."`). Preserves reasoning in the persisted record.
- C: The entire Q block content between openers (verbatim). Parser stores raw; any downstream stripping is that consumer's problem.
- D: Something else (please specify)

**Answer**: *Pending*

### Q2: Opener strictness when the colon is absent
**Context**: FR-001 says the outer regex must accept `### Q<n>` (no colon) in addition to `### Q<n>: <topic>`. FR-004 says FR-005 line-anchoring stays intact — mid-prose `as per Q1: yes` must not capture. That leaves one shape genuinely unresolved: a **bare `Q<n>` at line start with no heading marker and no colon** (e.g., `Q1\n**Answer:** X`). The existing regex `(?:#{1,6}\s+)?` makes the heading optional; if we also make the colon optional, `Q1\n…` becomes an opener, which widens beyond the byte-locked cockpit shape and risks false positives in prose that happens to start a line with `Q1`. Cockpit itself always emits `### Q<n>` (heading present), so restricting the colon-less form to heading-prefixed lines does not lose any real coverage.
**Question**: Which line shapes should qualify as block openers after the widening?
**Options**:
- A: Colon-less opener REQUIRES a markdown heading (`### Q<n>`, `## Q<n>`, `#### Q<n>`, etc.). Colon-required forms (`Q1:`, `**Q1**:`, bare `Q1:`) continue to open as they do today. Safest against prose false positives; covers the byte-locked cockpit shape exactly.
- B: Any line-anchored `Q<n>` opens a block — bare `Q1\n…` (no heading, no colon) also qualifies. Simplest widening; largest surface.
- C: Heading-prefixed OR bold-wrapped (`**Q1**` without colon) opens a colon-less block; bare unmarked `Q1\n` does not.
- D: Something else (please specify)

**Answer**: *Pending*

### Q3: Shared regex constant — MUST or SHOULD?
**Context**: FR-003 says `commentMatchesAnswerPattern` (`:97-99`) must stay in lockstep with the outer opener. The proposed-fix note in the spec and US2 AC both use soft language: *"consider extracting one shared pattern constant"* and *"extracting a shared pattern constant is preferred over maintaining two drifting copies."* That leaves it genuinely ambiguous whether extraction is part of the acceptance surface or a preference a reviewer can waive. This changes what "done" looks like: either (a) reviewers reject a PR that keeps two copies even if they demonstrably match, or (b) two synchronized copies with an explanatory comment are acceptable.
**Question**: Is extracting a single shared regex constant part of the acceptance surface for this fix, or a preference?
**Options**:
- A: MUST — the implementation must extract a single shared pattern constant. Two duplicate copies (even if in-lockstep and comment-linked) fail acceptance. This is the strongest guard against future drift.
- B: SHOULD — extract when straightforward, but two synchronized copies with a cross-referencing comment are acceptable if extraction introduces awkward coupling or is otherwise costlier than the drift risk it prevents.
- C: Something else (please specify)

**Answer**: *Pending*

### Q4: Real cockpit-posted comment fixture — MUST or SHOULD?
**Context**: SC-001's Measurement column says *"Unit test against real cockpit-body fixture."* US3 AC says *"At least one fixture is captured from a real cockpit-posted comment body rather than hand-written."* The Tests section says *"A fixture built from a real cockpit-posted comment body would be worth more than a hand-written string here"* — soft language. These read as inconsistent. If capturing a real body is blocking, the implementer needs to find or generate a real cockpit-posted comment (e.g., from an existing issue) before merge; if it's soft, a byte-accurate hand-written fixture that reproduces the locked schema is fine. The value proposition of "real" is that it catches drift in the *cockpit* side (agency repo), not the parser side — but the cockpit format is byte-locked by contract, so a hand-modeled fixture serves the same purpose *if* the model is faithful.
**Question**: Is at least one test fixture captured verbatim from a real cockpit-posted comment body required for this fix?
**Options**:
- A: MUST — at least one test fixture must be captured verbatim from a real cockpit-posted issue comment (from an actual GitHub issue in this repo or another Generacy repo). If no real cockpit-posted comment exists yet, capturing one is a prerequisite.
- B: SHOULD — a byte-accurate hand-written fixture that faithfully reproduces the byte-locked cockpit shape (per `agency/specs/400-operator-requested-ux/contracts/sb1-return-schema.md`) is acceptable. Capturing a real body is preferred but not blocking.
- C: Something else (please specify)

**Answer**: *Pending*

### Q5: FR-004 residual-race detector — dedicated test coverage or emergent consequence?
**Context**: The spec's Impact §3 says *"FR-004 residual-race detector never fires — gated behind the same patterns."* The acceptance criteria (SC-001..SC-004, US1-US3) test the integration path (SC-001), the three regression dialects (SC-002), the FR-013 untrusted-author explainer (SC-003), and the mid-prose non-capture regression (SC-004). FR-004 residual-race firing on a cockpit-format answer is not directly asserted. If it's an emergent consequence of unifying the pattern (per the "shared constant" thread in Q3), no dedicated test is needed. If it's a distinct behavior that could regress independently of the opener pattern, a dedicated test is needed.
**Question**: Should the acceptance surface include a dedicated regression test that proves FR-004 residual-race detection fires for a cockpit-format answer?
**Options**:
- A: Yes — add a regression test that constructs a residual-race scenario (per the FR-004 definition) with a cockpit-shaped answer body and asserts the detector fires. This pins the third guard feature the spec identifies as currently dead.
- B: No — FR-004's firing on cockpit-shaped bodies is an emergent consequence of Q3's pattern unification. If Q3 lands as MUST-share, the FR-004 path is covered by construction; a dedicated test is not required.
- C: Something else (please specify)

**Answer**: *Pending*
