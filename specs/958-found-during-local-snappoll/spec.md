# Feature Specification: Found during a local snappoll cluster run (`christrudelpw/snappoll`, cluster-base:preview, 2026-07-16)

**Branch**: `958-found-during-local-snappoll` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

Found during a local snappoll cluster run (`christrudelpw/snappoll`, cluster-base:preview, 2026-07-16). Extends **#909** — its marker-allowlist fix does not hold, for the reason in "Why #909's fix can't hold" below. Companion symptom to **#818** (clarify advances without pausing); armed by **#910** (cluster identity trusted on the answer-scanner surface), exactly as #909's own latent-corruption warning predicted.

`packages/orchestrator/src/worker/clarification-poster.ts` decides whether a comment is *questions* or *answers* by sniffing its **content** (`answer.includes('**Question**:') || answer.includes('**Context**:')`, L488). Content is a proxy for authorship, and it fails in **both** directions:

- **Fails open for the bot** → the engine reads its own questions comment as answers, the gate self-answers, planning proceeds on fabricated answers.
- **Fails closed for humans** → a developer who quotes the question while answering has their real answer silently discarded.

Both are the same defect. One authorship check fixes both.

## Observed A — gate self-answered, planning ran on fabricated answers (snappoll#7)

The agent posted 5 clarification questions at `04:19:07Z`, then integrated **its own questions comment** as the answers. `snappoll-worker-1`:

```
code: "TRANSITION_WITH_QUESTION_HEADINGS", commentId: 4988133748, questionNumber: 1,
answer: "Non-400 error handling\nThe spec defines only `201` and `400` behavior…"
msg: "Integrated answer from a comment containing question headings — possible bot self-answer"
  ×5 (questionNumber 1..5)
msg: "Integrated GitHub answers into clarifications.md" (count: 5)
msg: "Gate condition \"on-questions\" not met (no pending clarifications) — skipping"
```

Comment `4988133748` is the bot's own questions comment. Timestamp `04:19:27.962Z` is exactly when `completed:clarify` landed; `phase:plan` followed at `04:19:30Z`. `specs/007-phase-3-core-functionality/clarifications.md` on `origin/007-phase-3-core-functionality` has every `**Answer**:` field containing a restatement of its own question instead of `*Pending*`. Plan and tasks for #7 were produced from those five fabricated answers.

The FR-004 detector fired correctly five times, named the failure ("possible bot self-answer"), and integrated anyway — it is `logger.warn` with no control-flow effect.

## Observed B — human answers silently dropped (the friction this causes day to day)

Running the real `integrateClarificationAnswers` from `packages/orchestrator/dist`, single OWNER-authored comment, two pending questions:

| Answer style | integrated | resulting file |
|---|---|---|
| `Q1: A` / `Q2: B` | 2 ✅ | `["A","B"]` |
| **GitHub "Quote reply"** | **1 ❌** | `["*Pending*","B"]` |
| answer restating the question inline | **1 ❌** | `["*Pending*","B"]` |
| prose ("go with A for the first") | **0 ❌** | `no-answers` |
| numbered list (`1. A` / `2. B`) | **0 ❌** | `no-answers` |
| `**Q1**: A` | 2 ✅ | `["A","B"]` |

Mechanic: the answer capture (L466) runs from `Q1:` to the next **unquoted** `Q<n>:` at line start. A quoted `> ### Q2:` does not terminate it, so Q1's answer absorbs Q2's entire quoted question block; the L488 sniff then sees `**Question**:` inside the capture and discards the whole answer — including the valid `A` sitting at its head. Q2 survives only because nothing follows it.

This is why it looks intermittent: **it depends on whether the developer quoted before or after their answer.** Quote-reply on the last question works; on any earlier one it dies silently, `logger.warn` only.

Note the `> ` prefix protects the *marker* check (`clarification-markers.ts` column-0 rule, deliberate per its contract: "humans quoting the questions while answering still have their `Q<n>:` lines integrated") but **not** the L488 sniff, which is a plain `.includes()`. The quote-reply defense is half-built.

## Why #909's fix can't hold

#909 fix #1 was marker-based exclusion, on the premise *"the engine knows its own wire format; excluding by marker is deterministic where content sniffing is dialect-fragile."* That premise does not hold — **nothing deterministic writes the marker**:

- `STAGE_MARKERS` (`worker/types.ts` L90-94) contains only `specification`, `planning`, `implementation`. There is **no writer** for `<!-- generacy-stage:clarification`, allowlist entry 0.
- `clarify.ts` L376-403, the engine's own questions-posting path, emits **no marker at all** — it posts a bare `## Clarification Questions` header with options as `- A) …`.
- The comments actually on the issues match neither: they carry `❓`, "Batch 1", "Please answer inline", and `- **A**: …`. They are authored freehand by the agent, which improvises the marker per issue.

Four issues, one run, four different agent-invented markers — the gate held only by luck, twice over:

| Issue | Agent-invented marker | Allowlisted? | Body style | Sniff catches? | Outcome |
|---|---|---|---|---|---|
| #5 | `<!-- generacy-stage:clarification -->` | yes (luck) | verbose | — | paused ✅ |
| #8 | `<!-- generacy-stage:clarification -->` | yes (luck) | verbose | — | paused ✅ |
| #6 | `<!-- speckit-clarify:batch-1 -->` | **no** | verbose | yes (luck) | paused ✅ |
| #7 | `<!-- speckit-stage:clarification -->` | **no** | condensed | **no** | **gate blown** ❌ |

An allowlist cannot enumerate the dialects an LLM emits. Adding `speckit-` fixes this run and reopens on the next invented namespace.

## Fix

1. **Authorship, not content, decides whether a comment is an answer source.**
   - Human-authored → parse permissively; **never require a marker**. Manual `Q1: A` replies must keep working — this is the primary supported flow.
   - Cluster-self-authored (`viewerDidAuthor === true`) → only an answer source if it carries an **engine-written answer marker** (cockpit stamps it when relaying a human's answers). This is the narrow correction to #910's conflation of "this is the bot" with "this is authoritative".
   - Then retire L488's sniff as an authorship signal. It is the only thing standing between bot-self-answer and human-quote-reply, and it cannot serve both.
2. **Strip `> `-quoted lines before parsing**, and bound the capture at quoted blocks. Applies the column-0 rule consistently. Quote-reply then works.
3. **Never let trailing noise discard a valid leading answer** — keep the answer, drop the quoted tail.
4. **Make FR-004 fail closed.** `TRANSITION_WITH_QUESTION_HEADINGS` already identifies this exact case; it should block integration and leave the gate armed, not warn.
5. **Make `hasPendingClarifications` fail closed** (L381-400). Missing spec dir / unreadable file / unparseable content all currently return `false` = "advance". For a human gate, unknown must mean pause.

## Also in scope

- **A plain comment reply can never resume a paused gate.** The webhook is registered for `issues` only (`webhook-setup-service.ts` L346) and the handler drops everything that isn't `action === 'labeled'` (`routes/webhooks.ts` L72); `issue_comment` is never subscribed. `integrateClarificationAnswers` runs only inside the phase loop, i.e. only when the issue is already enqueued. So `completed:clarification` is load-bearing and reply-only answers wait forever. Dedicated monitors exist for merge-conflicts (#898) and PR feedback but not for clarification answers — a `waiting-for:clarification` + `agent:paused` → poll comments → integrate → resume monitor mirroring `MergeConflictMonitorService` would deliver the "just reply and it works" behaviour.
- **`completed:clarification` bypasses the gate whether or not answers parsed** (`phase-loop.ts` L785). When B above silently drops an answer, the label still advances to plan with `*Pending*` in the file. "Failed to pick up the answers" and "planned anyway" are one event. It should at minimum report which questions failed to parse rather than proceeding silently.
- **Prompt/parser placeholder mismatch (latent, same symptom).** `clarify.ts` L55 instructs `**Answer**: [Leave empty for now]`; the parser treats **only** the literal `*Pending*` as unanswered (`clarification-poster.ts` L303), and the write-back regex (L738-740) only matches `*Pending*`. Every agent so far has improvised `*Pending*` and got lucky. An agent that follows its own prompt marks **every** question answered and skips the gate on every issue.
- **The safety net sits downstream of the gate it protects.** `postClarifications()` is called at `phase-loop.ts` L815, inside the gate-active branch, past `if (!gateActive) continue` (L771). When the self-answer skips the gate the net never runs — which is why #7 has no `generacy-clarifications:7` comment. It goes quiet exactly when needed.
- **`completed:clarify` is granted before gates are evaluated.** `onPhaseComplete(phase)` at L723 runs before the gate check at L731, so the advance-authorizing label is applied unconditionally and `onGateHit` has to retract it (`label-manager.ts` L215-231). Any path that skips the gate leaves it in place.

Accepting `1. A` / prose answer forms would be a further permissiveness win, but it raises false-positive risk and should land only after authorship is the gate rather than content.

## Cleanup

`christrudelpw/snappoll#7`'s plan and tasks are derived from five fabricated answers and should be reset rather than reviewed (currently `phase:tasks` + `completed:plan`). #5/#6/#8 are correctly paused and unaffected; #2/#3/#4 have genuine human answers and their gate skips were legitimate.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)


## User Stories

### US1: Bot cannot answer its own clarification gate (P1)

**As a** cluster operator watching a speckit run,
**I want** the clarification gate to reject the bot's own questions comment as an answer source,
**So that** planning never proceeds on fabricated answers derived from restating the questions.

**Acceptance Criteria**:
- [ ] A comment authored by the cluster (`viewerDidAuthor === true`) is only treated as an answer source when it carries an engine-written answer marker.
- [ ] When the FR-004 `TRANSITION_WITH_QUESTION_HEADINGS` detector fires, integration is blocked and the gate remains armed; behaviour is fail-closed, not `logger.warn`.
- [ ] Replaying the snappoll#7 scenario (bot posts questions, no human reply) results in zero integrated answers, `waiting-for:clarification` retained, `phase:plan` never applied.
- [ ] `hasPendingClarifications` returns `true` on missing spec dir / unreadable / unparseable file (unknown → pause).

### US2: Human answers survive quote-reply and mid-comment quoting (P1)

**As a** developer answering clarification questions on GitHub,
**I want** my answer to be integrated whether or not I use GitHub's "Quote reply" button or quote the question inline,
**So that** I do not have to memorise which reply styles the engine happens to tolerate.

**Acceptance Criteria**:
- [ ] `> `-quoted lines (column-0 rule) are stripped before parsing; a quoted `> ### Q2:` bounds the Q1 capture.
- [ ] The GitHub "Quote reply" flow integrates every answered question, not only the last.
- [ ] An answer restating the question inline (`Q1: A ... > **Question**: ...`) integrates `A`; trailing quoted noise never discards a valid leading answer.
- [ ] Manual `Q1: A` / `**Q1**: A` replies continue to work unchanged (primary supported flow).

### US3: Reply-only answers resume a paused clarification gate (P2)

**As a** developer,
**I want** posting a plain comment on a `waiting-for:clarification` + `agent:paused` issue to eventually resume the phase,
**So that** I do not have to know to also toggle the `completed:clarification` label.

**Acceptance Criteria**:
- [ ] A `ClarificationAnswerMonitorService` (mirroring `MergeConflictMonitorService`) polls issues in `waiting-for:clarification` + `agent:paused`.
- [ ] On finding a new human-authored comment that yields at least one integrated answer, the monitor applies `completed:clarification` (or the equivalent resume trigger).
- [ ] No `issue_comment` webhook subscription is required — the monitor is authoritative.

### US4: Partial-parse failure is observable, not silent (P2)

**As a** cluster operator,
**I want** the label transition to `completed:clarification` to report which questions failed to parse,
**So that** "failed to pick up the answers" and "planned anyway" are no longer one event.

**Acceptance Criteria**:
- [ ] When the phase advances with any `*Pending*` remaining, the engine posts a comment (or `logger.warn` + relay event) enumerating unparsed question indices.
- [ ] The safety net (`postClarifications()`) runs regardless of gate skip — moved above `if (!gateActive) continue`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Authorship — not content — determines whether a comment is an answer source. Use GraphQL `viewerDidAuthor` (already fetched by #910's plumbing) to classify. | P1 | Replaces L488 `.includes('**Question**:')` sniff. |
| FR-002 | Human-authored comments are parsed permissively and never require a marker. | P1 | Primary supported flow. |
| FR-003 | Cluster-self-authored comments are answer sources only when they carry an engine-written answer marker (cockpit-stamped when relaying a human's answers). | P1 | Narrow correction to #910's "bot == authoritative" conflation. |
| FR-004 | `TRANSITION_WITH_QUESTION_HEADINGS` blocks integration and leaves the gate armed. | P1 | Convert `logger.warn` to fail-closed control flow. |
| FR-005 | Strip `> `-quoted lines before parsing; bound answer captures at quoted blocks (column-0 rule applied consistently). | P1 | Fixes quote-reply. |
| FR-006 | A valid leading answer is preserved when trailing noise (including quoted question blocks) would otherwise fail the capture. | P1 | Split answer at first quoted line rather than discard. |
| FR-007 | `hasPendingClarifications` fails closed: missing spec dir, unreadable file, and unparseable content all return `true` (= pause). | P1 | Currently returns `false` = advance. |
| FR-008 | `completed:clarify` is granted only after gate evaluation, not before. | P2 | `onPhaseComplete(phase)` at phase-loop.ts:723 moves below the gate check at :731; retract-on-hit code path (`label-manager.ts` L215-231) can then be simplified. |
| FR-009 | The safety net (`postClarifications()`) runs unconditionally on the clarify phase, not only in the gate-active branch. | P2 | Move above `if (!gateActive) continue` at phase-loop.ts:771. |
| FR-010 | Parse failures during answer integration are reported to the issue (comment + relay event), including question indices that remained `*Pending*`. | P2 | Silent partial-advance is the anti-goal. |
| FR-011 | Introduce `ClarificationAnswerMonitorService` polling `waiting-for:clarification` + `agent:paused` issues, integrating new human comments, and resuming on success. | P2 | Mirror `MergeConflictMonitorService` (#898). |
| FR-012 | The engine's `*Pending*` placeholder is unified: prompt (`clarify.ts` L55 `[Leave empty for now]`), parser (`clarification-poster.ts` L303), and write-back regex (L738-740) all agree on one literal. | P2 | Latent — an agent that follows its own prompt marks every question answered and skips every gate. |
| FR-013 | Cleanup: reset `christrudelpw/snappoll#7`'s plan and tasks (currently `phase:tasks` + `completed:plan`) since they derive from five fabricated answers. #5/#6/#8 (correctly paused) and #2/#3/#4 (genuine human answers) untouched. | P3 | One-shot repair, not a code change. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Bot self-answer of clarification gate | 0 occurrences across 100 test runs where the bot posts questions and no human replies | Replay snappoll#7 flow in integration test; assert `waiting-for:clarification` still set, `phase:plan` never applied, no `**Answer**:` fields populated with question restatement. |
| SC-002 | Human quote-reply integration rate | 100% of answered questions integrated regardless of quote-reply style (all six rows of the Observed B table) | Table-driven unit test against `integrateClarificationAnswers` covering: plain `Q1:`, GitHub "Quote reply", inline restatement, `**Q1**:`. Prose and numbered-list forms remain best-effort (not required to pass). |
| SC-003 | Marker-allowlist reliance | 0 code paths gate integration on marker match alone | Grep confirms `STAGE_MARKERS` / marker-allowlist is not the sole authorship signal; authorship uses `viewerDidAuthor`. |
| SC-004 | Reply-only resume latency | Median <2× monitor poll interval from human reply to phase resumption | Instrument `ClarificationAnswerMonitorService`; measure over local snappoll rerun. |
| SC-005 | Silent partial advance | 0 occurrences of `completed:clarification` applied while any `*Pending*` remains in `clarifications.md` without an accompanying parse-failure comment | Assert in integration test; count occurrences in production logs post-deploy. |
| SC-006 | `hasPendingClarifications` fail-closed behaviour | 100% of unknown states (missing dir / unreadable / unparseable) return `true` | Unit test the three failure branches. |
| SC-007 | Placeholder mismatch elimination | 0 divergent placeholder literals across prompt / parser / write-back | Grep; assert single constant re-used. |

## Assumptions

- The GraphQL `viewerDidAuthor` field is already fetched on the answer-scanner surface (per #910's plumbing). If not, this spec depends on that fetch being added.
- The engine-written answer marker used by cockpit-relayed human answers exists or can be added as part of this work (design decision to be nailed down in `/clarify` or `/plan`).
- `MergeConflictMonitorService`'s polling cadence and pause-label conventions are the reference model for `ClarificationAnswerMonitorService`.
- Cleanup of `christrudelpw/snappoll#7` is manual and does not require an engineering change beyond label / branch reset.
- Prose and numbered-list answer forms (`"go with A for the first"`, `1. A`) remain out of scope for this pass — permissiveness on those raises false-positive risk and should land only after authorship is the gate.

## Out of Scope

- Accepting prose or numbered-list answer forms.
- Subscribing to the `issue_comment` webhook (the monitor is the chosen mechanism, not a webhook expansion).
- Rewriting the marker-allowlist to enumerate agent-invented dialects (`speckit-clarify:batch-1`, `speckit-stage:clarification`, etc.). #909's approach is retired, not extended.
- Cockpit-side changes to how human answers are relayed, beyond ensuring the engine-written answer marker is present on cockpit-authored comments.
- Multi-repo / cross-cluster clarification flows.

---

*Generated by speckit*
