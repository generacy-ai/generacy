# Clarifications

## Batch 1 — 2026-07-16

### Q1: Engine-written answer marker
**Context**: FR-003 requires cluster-self-authored comments to carry an "engine-written answer marker" to be treated as an answer source (this is how cockpit-relayed human answers are distinguished from the bot's own questions comment). Assumption line 180 explicitly punts the design: *"exists or can be added as part of this work (design decision to be nailed down in `/clarify` or `/plan`)."* Without a decision, FR-003 cannot be implemented and cockpit-relayed human answers will be rejected the same way bot self-answers are.
**Question**: What is the marker format, and is defining/introducing it in-scope for this PR?
**Options**:
- A: This PR defines a new HTML-comment marker (e.g. `<!-- generacy-clarification-answers:<batch> -->`) and updates cockpit's relay path to stamp it. Both sides land together.
- B: This PR defines the marker but only teaches the parser to recognise it; cockpit stamping ships in a separate follow-up. In the interim, cockpit-relayed answers stay rejected (no regression vs. today because #910 already conflated bot == authoritative).
- C: Reuse an existing marker already emitted somewhere in the codebase (specify which).
- D: Do not use a marker — use a different authoritative signal (e.g. comment metadata, GraphQL author-association, a specific commenter identity).

**Answer**: *Pending*

### Q2: Canonical `*Pending*` placeholder literal
**Context**: FR-012 requires prompt (`clarify.ts` L55: `[Leave empty for now]`), parser (`clarification-poster.ts` L303: `*Pending*`), and write-back regex (L738-740: `*Pending*`) to agree on one literal. Today the prompt tells the agent to write one thing, the parser looks for another, and every run has silently depended on the agent improvising the parser's literal.
**Question**: Which literal becomes canonical, and does the parser also accept legacy values for backwards-compat during the transition?
**Options**:
- A: Canonical = `*Pending*`. Update the prompt to say `*Pending*` verbatim; parser accepts only `*Pending*`. No legacy support (in-flight batches will re-parse cleanly).
- B: Canonical = `*Pending*`. Prompt says `*Pending*`. Parser also treats an empty/whitespace-only `**Answer**:` value as pending, for tolerance.
- C: Introduce a shared constant (e.g. `PENDING_ANSWER_LITERAL`) imported by prompt template, parser, and write-back; value = `*Pending*`.
- D: Change the canonical literal to something else (specify).

**Answer**: *Pending*

### Q3: FR-004 fail-closed blast radius
**Context**: FR-004 says `TRANSITION_WITH_QUESTION_HEADINGS` must block integration and leave the gate armed. A single poll can find multiple candidate answer comments; the detector fires per-comment. The spec doesn't say whether one bad comment poisons the whole poll or is skipped in isolation.
**Question**: When the detector fires on one comment, what is the blast radius on the rest of the poll's work?
**Options**:
- A: Per-comment — skip only the offending comment; still integrate any other human-authored comments in the same poll. Gate stays armed only if the surviving integrations don't fill all pending questions.
- B: Per-poll — as soon as any comment trips the detector, abort the entire integration for this poll cycle. Gate stays armed regardless of what else was found. Emit a warning identifying the offender.
- C: Per-comment for humans; per-poll only when the offender is `viewerDidAuthor === true` (bot self-answer suspected — treat as adversarial).

**Answer**: *Pending*

### Q4: `ClarificationAnswerMonitorService` resume mechanism
**Context**: FR-011 says the monitor "applies `completed:clarification` (or the equivalent resume trigger)" on finding a comment that yields ≥1 integrated answer. That parenthetical hides a real design choice: do we go through the label pipeline (which involves `label-monitor-service`, another poll cycle, and re-integration by the phase loop) or short-circuit to the phase-loop's integration + resume path?
**Question**: How does the monitor cause the phase to resume after successful integration?
**Options**:
- A: Apply `completed:clarification` label and stop. The existing label pipeline handles the rest (issue is re-enqueued, phase loop re-integrates, gate is satisfied). Simplest; matches `MergeConflictMonitorService`.
- B: Persist integrated answers to `clarifications.md` in-process, then apply `completed:clarification`. Avoids the phase loop having to re-run integration.
- C: Directly enqueue a resume message (bypassing the label pipeline entirely) with a marker recording who resumed and why.

**Answer**: *Pending*

### Q5: FR-013 cleanup — snappoll#7 reset
**Context**: FR-013 is P3 and describes a one-shot repair of `christrudelpw/snappoll#7` (currently `phase:tasks` + `completed:plan`, both derived from five fabricated answers). The spec says "one-shot repair, not a code change" but doesn't say who runs it, when, or how it is tracked.
**Question**: How is the snappoll#7 cleanup delivered?
**Options**:
- A: Out of scope for this PR entirely — tracked as a separate one-off ops task the operator performs after the fix is deployed. Remove FR-013 from tasks.md.
- B: In-scope but manual — operator runs `gh` commands / label edits / branch reset by hand after deploy, documented in a runbook section of this PR (e.g. a short `RECOVERY.md`).
- C: In-scope and scripted — this PR adds a one-off `scripts/reset-snappoll-7.sh` (or equivalent) that resets the labels and optionally the branch. Executed once by an operator, then the script stays in the repo for reference.

**Answer**: *Pending*
