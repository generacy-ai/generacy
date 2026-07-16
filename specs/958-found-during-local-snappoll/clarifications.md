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

**Answer**: A — with one constraint: the marker must be written by deterministic code, not by an agent following prompt instructions, or we rebuild this exact bug on the answer side.

Proposed format: `generacy-clarification-answers:<batch>` as an HTML comment, matching the existing `clarification:batch-1` shape.

A correction to the premise, because it changes what "both sides land together" has to mean. Cockpit does not relay answers through code today. `cockpit advance` (`packages/generacy/src/cli/commands/cockpit/advance.ts` L162) posts only a `formatManualAdvanceComment` audit line and then applies `completed:clarification`. The drafted answers are posted freehand by the agent via `gh issue comment`. So cockpit-relayed answers do not work today because they are parsed — they work because `completed:clarification` bypasses the gate at `phase-loop.ts` L785 regardless of whether anything integrated. Whether cockpit's drafted answers ever reach `clarifications.md` is currently luck. That is a third instance of this issue's root cause, and it means B's "no regression vs. today" has no working parse path to regress.

So: A, and "updates cockpit's relay path to stamp it" must mean cockpit posts the answers through a tool that formats and stamps the marker deterministically (extend `cockpit_advance`, or add a sibling that posts answers and advances). If the skill keeps instructing the agent to free-write the comment, the marker is improvised per run — the exact lottery this issue documents (four different invented markers across four issues in a single run).

### Q2: Canonical `*Pending*` placeholder literal
**Context**: FR-012 requires prompt (`clarify.ts` L55: `[Leave empty for now]`), parser (`clarification-poster.ts` L303: `*Pending*`), and write-back regex (L738-740: `*Pending*`) to agree on one literal. Today the prompt tells the agent to write one thing, the parser looks for another, and every run has silently depended on the agent improvising the parser's literal.
**Question**: Which literal becomes canonical, and does the parser also accept legacy values for backwards-compat during the transition?
**Options**:
- A: Canonical = `*Pending*`. Update the prompt to say `*Pending*` verbatim; parser accepts only `*Pending*`. No legacy support (in-flight batches will re-parse cleanly).
- B: Canonical = `*Pending*`. Prompt says `*Pending*`. Parser also treats an empty/whitespace-only `**Answer**:` value as pending, for tolerance.
- C: Introduce a shared constant (e.g. `PENDING_ANSWER_LITERAL`) imported by prompt template, parser, and write-back; value = `*Pending*`.
- D: Change the canonical literal to something else (specify).

**Answer**: C — a shared constant (`PENDING_ANSWER_LITERAL`), value `*Pending*`, imported by the prompt template, the parser, and the write-back regex.

C is the only option that makes divergence structurally impossible rather than re-synchronising two copies that will drift again. A and B both leave the prompt and the parser as independent string literals, which is how we got here.

Add B's tolerance on top, as fail-closed policy: treat empty, whitespace-only, and any square-bracketed placeholder as pending. The current prompt literally instructs the agent to leave the field empty, so "empty" must never read as answered. Anything that is not a recognisable answer is pending — the failure direction has to be "ask again", never "advance". That bracketed-placeholder rule also subsumes the legacy `[Leave empty for now]` value, so no separate legacy handling is needed.

### Q3: FR-004 fail-closed blast radius
**Context**: FR-004 says `TRANSITION_WITH_QUESTION_HEADINGS` must block integration and leave the gate armed. A single poll can find multiple candidate answer comments; the detector fires per-comment. The spec doesn't say whether one bad comment poisons the whole poll or is skipped in isolation.
**Question**: When the detector fires on one comment, what is the blast radius on the rest of the poll's work?
**Options**:
- A: Per-comment — skip only the offending comment; still integrate any other human-authored comments in the same poll. Gate stays armed only if the surviving integrations don't fill all pending questions.
- B: Per-poll — as soon as any comment trips the detector, abort the entire integration for this poll cycle. Gate stays armed regardless of what else was found. Emit a warning identifying the offender.
- C: Per-comment for humans; per-poll only when the offender is `viewerDidAuthor === true` (bot self-answer suspected — treat as adversarial).

**Answer**: C — per-comment for human-authored comments, per-poll when `viewerDidAuthor === true`.

Once FR-003 lands, the bot's own questions comment is excluded on authorship before the detector ever runs. So a self-authored comment that still trips the detector means one carrying a valid answer marker AND question headings — either a cockpit relay bug or a forged/improvised marker. That is a malfunction of unknown extent, so aborting the poll and leaving the gate armed is the right blast radius.

A human tripping it is overwhelmingly likely to be an ordinary quote-reply, which must never block other people's answers in the same poll. And after the quote-stripping fix, a quote-reply should not trip it at all.

B is too blunt in the other direction: one malformed human comment would silently discard everyone else's real answers, which is precisely the friction this issue exists to remove.

### Q4: `ClarificationAnswerMonitorService` resume mechanism
**Context**: FR-011 says the monitor "applies `completed:clarification` (or the equivalent resume trigger)" on finding a comment that yields ≥1 integrated answer. That parenthetical hides a real design choice: do we go through the label pipeline (which involves `label-monitor-service`, another poll cycle, and re-integration by the phase loop) or short-circuit to the phase-loop's integration + resume path?
**Question**: How does the monitor cause the phase to resume after successful integration?
**Options**:
- A: Apply `completed:clarification` label and stop. The existing label pipeline handles the rest (issue is re-enqueued, phase loop re-integrates, gate is satisfied). Simplest; matches `MergeConflictMonitorService`.
- B: Persist integrated answers to `clarifications.md` in-process, then apply `completed:clarification`. Avoids the phase loop having to re-run integration.
- C: Directly enqueue a resume message (bypassing the label pipeline entirely) with a marker recording who resumed and why.

**Answer**: C — enqueue a resume. The monitor must never apply `completed:clarification`.

Two corrections to A's premise. First, it does not match `MergeConflictMonitorService`: that service enqueues a `resolve-merge-conflicts` queue item via `enqueueIfAbsent` (`merge-conflict-monitor-service.ts` L113-169) and never applies a completed label. C is the option that actually mirrors the precedent.

Second, and more important: `completed:clarification` is a force-advance override, not a resume signal. At `phase-loop.ts` L785 it bypasses the pause whether or not any answer parsed. FR-011 triggers on ">=1 integrated answer", so under A an issue with one of five questions answered would be force-advanced into plan with four still pending — this issue's own bug, rebuilt inside the fix.

The resume needs no label at all. The gate already deactivates by itself when the file has no pending questions (`phase-loop.ts` L771). So: the monitor detects a new human-authored comment on `waiting-for:clarification` + `agent:paused`, enqueues a resume, and the phase loop integrates — it is the component that has a checkout, which also rules B out, since the orchestrator monitor has none. If everything is answered the gate deactivates naturally; if questions remain it re-arms and pauses again. `completed:clarification` then stays what it should be: the human's explicit "proceed anyway, I know parsing failed" override.

### Q5: FR-013 cleanup — snappoll#7 reset
**Context**: FR-013 is P3 and describes a one-shot repair of `christrudelpw/snappoll#7` (currently `phase:tasks` + `completed:plan`, both derived from five fabricated answers). The spec says "one-shot repair, not a code change" but doesn't say who runs it, when, or how it is tracked.
**Question**: How is the snappoll#7 cleanup delivered?
**Options**:
- A: Out of scope for this PR entirely — tracked as a separate one-off ops task the operator performs after the fix is deployed. Remove FR-013 from tasks.md.
- B: In-scope but manual — operator runs `gh` commands / label edits / branch reset by hand after deploy, documented in a runbook section of this PR (e.g. a short `RECOVERY.md`).
- C: In-scope and scripted — this PR adds a one-off `scripts/reset-snappoll-7.sh` (or equivalent) that resets the labels and optionally the branch. Executed once by an operator, then the script stays in the repo for reference.

**Answer**: A — out of scope for this PR, remove FR-013.

snappoll is a throwaway demo repo. A `scripts/reset-snappoll-7.sh` committed to generacy would be dead code the day it merges, and a RECOVERY.md section for one issue in a personal test repo is documentation nobody will read. The reset is a label edit plus a branch discard, done out of band.

If a general recovery procedure is wanted, that is its own issue and a different shape: detect any issue whose `clarifications.md` contains answers that restate their own question text — the fingerprint this bug leaves — across real repos, and reset those. That is worth filing: snappoll#7 is the one we know about because we happened to be watching, not necessarily the only one.
