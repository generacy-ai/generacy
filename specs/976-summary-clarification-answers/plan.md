# Implementation Plan: Honor same-account clarification answers

**Feature**: Clarification answers posted from the cluster's own GitHub account are silently dropped. Fix the two `#958` `viewerDidAuthor === true` gates so plain `Q<n>:` replies from a same-account human operator auto-resume and integrate — without a machine marker, without a config flag, and without any identity classification. Marker-based machine exclusion only.
**Branch**: `976-summary-clarification-answers`
**Status**: Complete

## Summary

The bug is exactly two lines of code sitting in front of an already-correct trust helper (`comment-trust.ts:122` — self-authored is trusted). Both lines skip a same-account comment purely on the basis of `viewerDidAuthor === true`; both live in code paths that already have a marker-based mechanism to keep machine chatter out of the answer stream. The fix is to drop the identity gate at both sites and lean on the marker mechanism — broadened from `CLARIFICATION_QUESTION_MARKERS` to a canonical `MACHINE_MARKERS` set that covers every family of cluster-emitted comment the scanner must never treat as an answer.

Two call sites, one shared marker set:

1. **Monitor** (`packages/orchestrator/src/services/clarification-answer-monitor-service.ts:198-209`) — delete the `if (c.viewerDidAuthor === true) continue;` short-circuit. Replace the paired `if (commentCarriesAnswerMarker(c.body)) continue;` with the broader `if (commentCarriesMachineMarker(c.body)) continue;`. Every comment surviving the marker filter goes through `isTrustedCommentAuthor`, exactly as today for the different-account path.

2. **Phase-loop answer-scanner** (`packages/orchestrator/src/worker/clarification-poster.ts:853-870, 916-936`) — broaden the pre-filter at L855 from `matchClarificationQuestionMarker` to a new `matchMachineMarker`. Delete the entire `viewerDidAuthor === true` disjunction at L918-931 — trusted, marker-free comments are candidates unconditionally, per Q4=A parity with the different-account path (FR-006 from #958).

Both sites converge on the same marker set defined in `packages/orchestrator/src/worker/clarification-markers.ts`. FR-007 failure surfacing is satisfied by the existing `generacy-clarification-parse-failures:` explainer path (`phase-loop.ts:1168`) — same-account parse failures now naturally travel that path because the identity gate is gone. No changes to `postUntrustedAnswerExplainers` are required (that path is trust-tier rejection; same-account is trusted).

## Technical Context

- **Language/Version**: TypeScript (ESM, Node >=22)
- **Primary Dependencies**: None new — this is a scanner-side broadening of an existing marker set. `commentCarriesAnswerMarker` / `matchClarificationQuestionMarker` / `commentCarriesMachineMarker` all live in one file.
- **Packages touched**: `packages/orchestrator/` only. No cross-package plumbing, no shared type surface changes, no MCP schema changes, no cluster-relay wire changes.
- **Test runner**: Vitest (existing convention in `packages/orchestrator/src/{worker,services}/__tests__/`).
- **Storage**: None. The change is pure code — no persistent state, no cache invalidation, no migration.
- **Performance goals**: N/A — marker matching is line-anchored substring; broadening from 4 prefixes to ~10 is negligible per comment.
- **Constraints**:
  - MUST NOT change the trust helper (`comment-trust.ts`) — self-authored trust is load-bearing behavior from #910 (App-identity clusters recognizing their own posts).
  - MUST NOT change any comment marker text — every family listed in `MACHINE_MARKERS` is a stable string emitted somewhere in the tree; renaming would break existing GitHub-side idempotence.
  - MUST NOT introduce a config flag, an identity signal, or a `GITHUB_ACTOR`-shaped runtime check (Q1=A explicitly rejects those).
  - MUST apply the broadened filter at BOTH call sites (monitor + phase-loop scanner) — divergence reintroduces the observed bug (monitor auto-resumes but phase loop drops the answer, or vice-versa).

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

Existing project conventions honoured:

- **Changeset required** (`.github/workflows/changeset-bot.yml`) — diff touches non-test files under `packages/orchestrator/src/`. `bump` level = `patch` (`orchestrator` has no public API surface; behavior change only). Test-only edits are exempt from the gate but land in the same PR.
- **No comments describing WHAT** — helper names (`commentCarriesMachineMarker`, `matchMachineMarker`) carry their own meaning. `Why:` comments only where a marker prefix's inclusion or exclusion isn't obvious (see research §Decision 3 for `generacy-clarification-answers:`).
- **Do not add features beyond spec scope** — this plan does NOT: delete `cockpit_relay_clarify_answers`, add a deprecation warning, change any poster's marker text, or touch the trust helper. Migration considerations for the marker-relay tool are called out in `research.md` §Decision 3 but explicitly deferred.
- **Vitest, no snapshot fixtures** — matches existing test style in `packages/orchestrator/src/{worker,services}/__tests__/`.
- **Both call sites tested** — SC-002 style contract (from #958) is preserved: a single test file per behavior slice, one asserting the monitor's `enqueueIfAbsent` fires, one asserting the phase-loop's `integrateClarificationAnswers` returns `integrated > 0`.

## Project Structure

```
packages/orchestrator/
  src/
    worker/
      clarification-markers.ts             MOD  — add `MACHINE_MARKERS: readonly string[]`
                                                  (superset of CLARIFICATION_QUESTION_MARKERS)
                                                  + `commentCarriesMachineMarker(body)`
                                                  + `matchMachineMarker(body)`.
                                                  Existing `CLARIFICATION_QUESTION_MARKERS`,
                                                  `commentCarriesQuestionMarker`,
                                                  `matchClarificationQuestionMarker` remain
                                                  (callers under `clarification-comment-finder.ts`
                                                  in `packages/generacy/` still depend on
                                                  the question-only surface — see Risk R-2).
                                                  Existing `CLARIFICATION_ANSWER_MARKERS` /
                                                  `commentCarriesAnswerMarker` also remain —
                                                  unused post-fix but exported (grep for
                                                  cross-package consumers before deletion).
      clarification-poster.ts              MOD  — L855 pre-filter: swap
                                                  `matchClarificationQuestionMarker` for
                                                  `matchMachineMarker`. L916-936: replace
                                                  the entire `if (c.viewerDidAuthor === true)
                                                  { … } else { … }` disjunction with a single
                                                  `answerComments.push(c)` — every trusted
                                                  candidate is a candidate answer.
                                                  Structured log at L923 (`clarification-
                                                  answer-scanner-self-unmarked`) is deleted;
                                                  the corresponding scenario now integrates
                                                  and its integration is logged by the
                                                  existing "Integrated GitHub answers into
                                                  clarifications.md" line at L1029.
      __tests__/
        clarification-markers.test.ts      MOD  — add cases for `MACHINE_MARKERS`
                                                  positive/negative coverage.
        clarification-machine-markers.test.ts NEW — exhaustive MACHINE_MARKERS table:
                                                  every prefix from `contracts/machine-
                                                  markers.md` §Inventory positively matches;
                                                  the `generacy-clarification-answers:` prefix
                                                  is asserted to be INCLUDED per Q2=A; a
                                                  human-written body containing "generacy-
                                                  clarifications:" as plain text (no comment
                                                  wrapper) does NOT match.
        clarification-poster.test.ts       MOD  — retire the "cluster-self unmarked skipped"
                                                  assertion; add positive "cluster-self plain
                                                  Q<n>: reply integrates" case.
        clarification-self-answer.test.ts  MOD  — SC-001 file. Test at L163 ("WITHOUT engine
                                                  marker → zero integrated") inverts to
                                                  `integrated: 1`. Test at L185 ("WITH engine
                                                  marker → integrated") inverts to
                                                  `integrated: 0` (marker-relay comments are
                                                  now excluded via MACHINE_MARKERS —
                                                  documented deprecation, tracked as
                                                  follow-up per research §Decision 3).
                                                  L120-160 case ("questions comment + no
                                                  human reply → zero integrated") STAYS as-is
                                                  — questions marker still excludes.
        clarification-poster-trust.test.ts  UNCHANGED  — trust-tier rejection logic and
                                                        untrusted-answer explainer path are
                                                        unaffected.
    services/
      clarification-answer-monitor-service.ts  MOD  — L198-209: delete
                                                       `if (c.viewerDidAuthor === true)
                                                       continue;` and rewrite the paired
                                                       `commentCarriesAnswerMarker` check to
                                                       `commentCarriesMachineMarker`. Update
                                                       import at L42.
      __tests__/
        clarification-answer-monitor-service.test.ts  MOD  — Test at L199-232 ("cluster-self
                                                             comment only → no enqueue")
                                                             splits into TWO tests:
                                                             (a) cluster-self MACHINE-marker
                                                                 comment → no enqueue (still
                                                                 correct; new marker set),
                                                             (b) cluster-self plain Q<n>:
                                                                 comment → ENQUEUES (SC-001
                                                                 positive path).

specs/976-summary-clarification-answers/
  spec.md               (untouched — read-only)
  clarifications.md     (unchanged)
  plan.md               NEW (this file)
  research.md           NEW
  data-model.md         NEW
  contracts/
    machine-markers.md  NEW  — MACHINE_MARKERS inventory + match rule + both call-site
                               contracts (monitor decision, phase-loop decision).
  quickstart.md         NEW

.changeset/
  976-same-account-clarification-answers.md  NEW — `patch` for `@generacy-ai/orchestrator`
                                                   (behavior change; no public API surface
                                                   change; internal only). Text: "Same-account
                                                   plain Q<n>: replies on paused clarify
                                                   issues now auto-resume and integrate."
```

**Structure Decision**: All code changes live inside `packages/orchestrator/`. The marker set is authored once in `clarification-markers.ts` and consumed at two sites in the same package — no cross-package export needed. `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` currently has its own inline `STAGE_STATUS_REJECT_PREFIXES` list (a superset-adjacent set with its own semantics for the cockpit surface); intentionally NOT unifying with `MACHINE_MARKERS` in this feature — the cockpit finder answers a different question ("which comment is the human's reply to the clarification prompt?") and lives on the CLI side of the process boundary. Consolidation would be a bigger cross-package refactor and is out of scope. Called out in Risk R-2.

## Design Overview

### `MACHINE_MARKERS` (`packages/orchestrator/src/worker/clarification-markers.ts`)

Single, ordered, `readonly string[]` exported constant. The full inventory is fixed by Q2=A:

```ts
export const MACHINE_MARKERS: readonly string[] = [
  // Question-family (unchanged from CLARIFICATION_QUESTION_MARKERS)
  '<!-- generacy-stage:clarification',
  '<!-- generacy-clarifications:',
  '<!-- generacy-clarification:',
  '<!-- generacy-cockpit:clarifications-batch:',

  // Stage/status comments (spec §Q2)
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:implementation',

  // Audit / lifecycle bot comments (spec §Q2)
  '<!-- generacy-cockpit:manual-advance',

  // Answer-marker relay (spec §Q2 — cockpit_relay_clarify_answers stamps)
  '<!-- generacy-clarification-answers:',

  // Bot-authored explainer / diagnostic comments (spec §Q2)
  '<!-- generacy-untrusted-answer:',
  '<!-- generacy-clarification-parse-failures:',
] as const;
```

Match rule (identical to the existing `CLARIFICATION_QUESTION_MARKERS` rule, deliberately copied):

- Prefix substring, case-sensitive ASCII.
- Line-anchored: only fires when the marker starts at column 0 of some line.
- `> `-quoted markers therefore do NOT match — humans quoting a machine comment while answering still have their `Q<n>: <answer>` lines integrated. This is the load-bearing property that makes plain quote-reply answers work under the existing `clarification-quote-reply.test.ts` scenarios.

Existing `CLARIFICATION_QUESTION_MARKERS`, `commentCarriesQuestionMarker`, `matchClarificationQuestionMarker` are unchanged — `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` uses a similar concept but its own inline constant, and `clarification-poster.ts::isQuestionComment` (elsewhere in the same file) still delegates to `commentCarriesQuestionMarker`. Retiring the question-only surface is out of scope.

Existing `CLARIFICATION_ANSWER_MARKERS` / `commentCarriesAnswerMarker` / `matchClarificationAnswerMarker` are also unchanged AT THE EXPORT LEVEL — no runtime callers post-fix (all removed by the L919 deletion in `clarification-poster.ts` and the L203 replacement in the monitor), but the answer-marker prefix is a SUBSTRING of a `MACHINE_MARKERS` entry (`'<!-- generacy-clarification-answers:'`), so the export and the `MACHINE_MARKERS` entry stay lockstep. Follow-up deletion is a low-value cleanup; leave them in place to avoid a wider test refactor in this PR.

### Monitor call-site (`clarification-answer-monitor-service.ts:198-209`)

Before:
```ts
for (const c of comments) {
  if (c.viewerDidAuthor === true) continue;              // ← deleted
  if (commentCarriesAnswerMarker(c.body)) continue;      // ← replaced
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
  if (decision.trusted) { hasHumanTrustedComment = true; break; }
}
```

After:
```ts
for (const c of comments) {
  if (commentCarriesMachineMarker(c.body)) continue;
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
  if (decision.trusted) { hasHumanTrustedComment = true; break; }
}
```

The trust helper's own self-authored branch (`comment-trust.ts:122`, `reason: 'self-authored'`) now determines the outcome for same-account comments — exactly the design intent per FR-002 / FR-006 from #958.

Post-fix behaviour on the observed agency#433 scenario:
- Same-account plain `Q1: A\nQ2: B\nQ3: B` — no machine marker present → trust check passes (self-authored) → `hasHumanTrustedComment = true` → `enqueueIfAbsent` fires → phase-loop resumed → answers integrated (via the parallel phase-loop fix below).
- Same-account cluster-emitted question comment (`<!-- generacy-clarifications:… -->`) — marker present at column 0 → `continue` → not counted.
- Same-account marker-relay comment (`<!-- generacy-clarification-answers:… -->`) — marker present at column 0 → `continue` → not counted. This is the deprecation of the marker-relay path; documented in research §Decision 3.

Import churn:
- Delete `commentCarriesAnswerMarker` from the L42 import; add `commentCarriesMachineMarker`.

### Phase-loop scanner call-site (`clarification-poster.ts:853-870, 916-936`)

Pre-filter (L853-870): swap `matchClarificationQuestionMarker` for `matchMachineMarker`. The log message string `'Excluded from answer-scanner via question marker'` becomes `'Excluded from answer-scanner via machine marker'` and the log meta field `markerPrefix` continues to carry the specific matched prefix (now drawn from `MACHINE_MARKERS`).

Trust-gated candidate assembly (L883-897) — unchanged. `isTrustedCommentAuthor` handles the same-account branch via `reason: 'self-authored'` today.

Answer-comment assembly (L916-936). Before:
```ts
const answerComments: TrustComment[] = [];
for (const c of trustedComments) {
  if (c.viewerDidAuthor === true) {
    if (commentCarriesAnswerMarker(c.body)) {
      answerComments.push(c);
    } else {
      logger.debug({ … }, 'Skipped cluster-self comment lacking engine-written answer marker (FR-003)');
    }
  } else {
    answerComments.push(c);  // FR-002
  }
}
```

After:
```ts
const answerComments: TrustComment[] = trustedComments;
```

Rationale for a bare aliasing (rather than a `for` loop): every trusted, marker-free comment is a candidate. The FR-004 asymmetric fail-close on `sourceHadQuestionHeadings` at L953-989 still keys off `parsed.sourceViewerDidAuthor === true` per-question — that discriminator lives inside `parseAnswersFromComments` and is retained. Machine question-heading confusion for a cluster-self comment still aborts the whole poll (FR-004 fail-closed) for the same reason today: this is a shape-check, not an identity gate.

The four-arm log point at L923-930 is deleted. It described a scenario that no longer exists post-fix (a same-account unmarked comment reaching the answer-comment stage). If a same-account comment fails to yield answers, the existing parse-failure flow already emits a `parseFailures[]` entry and the phase-loop's `generacy-clarification-parse-failures:` explainer comment mechanism (`packages/orchestrator/src/worker/phase-loop.ts:1168`) surfaces the failure to the operator — satisfying FR-007 without any change to `postUntrustedAnswerExplainers` (that path is trust-tier rejection and never applied to same-account, which is always trusted).

### FR-007 traceability

FR-007 (spec §Acceptance): "if a same-account answer can't be parsed, surface it". Post-fix flow:

1. Same-account plain answer, valid `Q<n>:` shape → integrated. `integrated > 0` on the `IntegrationResult`. No explainer needed.
2. Same-account comment, no `Q<n>:` at all → not treated as a candidate at all (parse yields empty map → `no-answers` return). Consistent with different-account behaviour today; no explainer needed (nothing to explain about a comment the parser doesn't recognize as an answer attempt).
3. Same-account comment with `Q<n>:` shape but parse fails for a specific question (e.g. `sourceHadQuestionHeadings` → FR-004 abort, or answer text doesn't match any pending question) → `parseFailures[]` populated → phase-loop's `renderClarificationParseFailuresComment` posts `<!-- generacy-clarification-parse-failures:<issue> -->` explainer. This IS "the existing untrusted-answer explainer path" in spirit (Q3=A wording is slightly imprecise about which explainer family carries this; the parse-failures family is the applicable one).

Explicit non-change: `postUntrustedAnswerExplainers` is unchanged. `<!-- generacy-untrusted-answer: -->` explainer comments only fire for untrusted-tier authors; same-account is trusted. This is the correct trust-tier separation.

## Behaviour Matrix

### Monitor decision (post-fix)

| viewerDidAuthor | comment body carries MACHINE_MARKERS prefix | isTrustedCommentAuthor | enqueue? | notes |
|---|---|---|---|---|
| true | no | true (`self-authored`) | ✓ | SC-001 positive path |
| true | yes (`generacy-clarifications:`) | — | ✗ | machine question comment |
| true | yes (`generacy-stage:planning`) | — | ✗ | stage-status comment |
| true | yes (`generacy-cockpit:manual-advance`) | — | ✗ | audit comment |
| true | yes (`generacy-clarification-answers:`) | — | ✗ | marker-relay comment (Q2=A deprecation) |
| true | yes (`generacy-untrusted-answer:`) | — | ✗ | bot explainer comment |
| true | yes (`generacy-clarification-parse-failures:`) | — | ✗ | bot explainer comment |
| false | no | true (OWNER/MEMBER/COLLAB) | ✓ | existing #958 path (unchanged) |
| false | no | false (drive-by) | ✗ | existing trust-tier gate |
| false | yes | — | ✗ | machine comment from another cluster (rare but must skip) |

`—` = irrelevant because the marker filter is evaluated first (short-circuits).

### Phase-loop scanner decision (post-fix)

| viewerDidAuthor | matchMachineMarker | isTrustedCommentAuthor | comment matches `Q<n>:` | outcome |
|---|---|---|---|---|
| true | no | true | yes | integrated (SC-002 positive path) |
| true | no | true | no | not counted as candidate; no side effect |
| true | yes | — | — | excluded by pre-filter L855 |
| false | no | true | yes | integrated (existing #958 path) |
| false | no | true | no | not counted; possibly untrusted-explainer via `commentMatchesAnswerPattern` gate |
| false | no | false | yes | untrusted-explainer posted (existing FR-013 path) |
| false | yes | — | — | excluded by pre-filter L855 |

### `sourceHadQuestionHeadings` fail-closed (unchanged)

The FR-004 asymmetric fail-close at L951-988 continues to key off `parsed.sourceViewerDidAuthor === true`. That property is the authorship signal of the comment that produced a given answer, and it independently bounds the blast radius of a same-account answer that spuriously matched a `### Q<n>:` heading pattern. Not affected by the identity-gate removal above.

## Risks and Mitigations

1. **R-1 — Marker-relay path silently regresses** (Q2=A deprecates it). `cockpit_relay_clarify_answers` posts a comment carrying `<!-- generacy-clarification-answers: -->` at column 0. Post-fix, this prefix is in `MACHINE_MARKERS` → the pre-filter drops the whole comment → answers not integrated even though the tool "succeeded" on the write side. Mitigation: `research.md` §Decision 3 documents the deprecation with a follow-up issue reference; two `clarification-self-answer.test.ts` cases explicitly invert to lock in the new behavior; the tool itself is not deleted this PR (external MCP consumers may still call it — its writes just become no-ops for integration). Follow-up: emit a stderr warning on tool invocation and/or auto-post a marker-free companion body.

2. **R-2 — Cockpit finder marker set drifts from orchestrator MACHINE_MARKERS**. `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts:15-21` has its own inline `STAGE_STATUS_REJECT_PREFIXES` (finder-side responsibility: pick the right comment to relay to the human). The two lists overlap but are not identical (finder covers stage/status only; MACHINE_MARKERS is a superset). If future edits add a marker family on one side and forget the other, the two surfaces disagree. Mitigation: explicit note in `contracts/machine-markers.md` §Cross-surface consistency; cross-package unification tracked as a follow-up (see the `#889`-shaped cross-package marker registry proposal). Not blocking this feature.

3. **R-3 — Deleted `viewerDidAuthor === true` branch breaks a test relying on the branch's log line**. `clarification-answer-scanner-self-unmarked` structured log at L923-930 is deleted; grep for other consumers before the PR lands. If any downstream test / observer asserted on that log identifier, it needs updating in the same PR.

4. **R-4 — Trust helper regression (`comment-trust.ts:122`) makes the fix moot**. The whole fix leans on `self-authored → trusted`. If a future change makes `self-authored` conditional (e.g. hides it behind a config), the observed bug returns. Mitigation: the two acceptance tests (SC-001 monitor + SC-002 phase-loop) exercise the full path, including the trust helper — a regression in trust would fail them. The trust helper itself is out of scope for this feature.

5. **R-5 — Explosive log volume from broadened pre-filter**. The `matchMachineMarker` log at L857 now fires for many more comment families. On an issue with dozens of stage/status/manual-advance comments, `logger.debug` fires per skip. Mitigation: log level is `debug`, matches the existing convention for `matchClarificationQuestionMarker`. If it becomes an operator complaint, sample or aggregate. Not blocking.

6. **R-6 — `CLARIFICATION_QUESTION_MARKERS` and `MACHINE_MARKERS` diverge over time**. Two overlapping constants in the same file invite drift. Mitigation: `MACHINE_MARKERS` is defined as an explicit superset (spread `...CLARIFICATION_QUESTION_MARKERS` at the top). If a future PR adds a new question marker, `MACHINE_MARKERS` picks it up for free. Documented in `data-model.md`.

## Testing Strategy

### Unit tests

- **`clarification-machine-markers.test.ts` (NEW)** — Coverage:
  - Every prefix in `MACHINE_MARKERS` positively matches on `commentCarriesMachineMarker` (loop over the const).
  - `>` -quoted marker (`'> <!-- generacy-stage:planning ...'`) does NOT match — column-0 rule.
  - A comment body containing `generacy-clarifications:` as prose (no `<!--` wrapper) does NOT match.
  - `matchMachineMarker` returns the specific matched prefix (identity from the constant).
  - `MACHINE_MARKERS` is a superset of `CLARIFICATION_QUESTION_MARKERS` (structural assertion — every entry in the smaller set appears in the larger).

- **`clarification-markers.test.ts` (MOD)** — no new tests, just delete the "unrelated marker family" assertion at L36 that used `generacy-untrusted-answer:5` as a *negative* case for `commentCarriesQuestionMarker`. That test is still valid (question-marker predicate remains narrow); no change needed. Documented for reviewer clarity.

### Behavior tests

- **`clarification-self-answer.test.ts` (MOD)** — the SC-001 regression file:
  - Case at L120-160 ("questions comment + no human reply → zero integrated") — UNCHANGED. Still asserts questions-marker filter still fires.
  - Case at L163 ("cluster-self answer WITHOUT engine marker → zero integrated") — INVERT to `integrated: 1` and `writeFileSync` was called with `**Answer**: OAuth 2.0` … `**Answer**: info`. Rename to "cluster-self plain Q<n>: reply → integrated (#976)".
  - Case at L185 ("cluster-self answer WITH engine marker → integrated") — INVERT to `integrated: 0` (marker-relay comment now excluded via MACHINE_MARKERS). Rename to "cluster-self marker-relay comment → excluded (#976 Q2=A deprecates marker-relay)". Note in the test docstring that this codifies the marker-relay deprecation.

- **`clarification-poster.test.ts` (MOD)** — add one positive case for same-account plain answer under the existing "answer integration" describe block, mirroring the existing different-account case. Structural check: `integrated: 1` with `mockWriteFileSync` capturing the expected body.

- **`clarification-answer-monitor-service.test.ts` (MOD)** — replace the L199-232 case:
  - (a) NEW case "cluster-self machine comment (MACHINE_MARKERS) → no enqueue" — cluster-self with each machine marker family in turn (parameterized). Assert `enqueueIfAbsent` not called.
  - (b) NEW case "cluster-self plain Q<n>: comment → enqueues continue (#976 SC-001)" — cluster-self, no marker, `Q1: OAuth`. Assert `enqueueIfAbsent` called with `command: 'continue'`, `queueReason: 'resume'`.
  - Existing cases (L87-121 human-authored, L123-198 precondition/blocked, L234-308 dedupe/no-labels) UNCHANGED.

### Regression tests (not modified)

- `clarification-poster-trust.test.ts` — trust-tier gating for untrusted authors + explainer posting. Both call sites' trust behavior unchanged; existing tests continue to pass.
- `clarification-quote-reply.test.ts` — quoted-marker case. The `> `-prefix rule is unchanged; existing assertions still hold.
- `clarification-poster-viewer-auth.test.ts` — GraphQL `viewerDidAuthor` field wiring. Untouched; the field is still consumed by `parseAnswersFromComments` for `sourceViewerDidAuthor` (FR-004 fail-close).
- `clarification-poster-graphql-failure.test.ts` — retry semantics. Untouched.

### Integration test (behavior end-to-end)

Not required. The unit + behavior tests exercise both call sites' full paths (including trust helper invocation via the real `@generacy-ai/workflow-engine` module, per the existing `clarification-poster-trust.test.ts` pattern). The observed agency#433 scenario is directly reproducible by the "cluster-self plain Q<n>: comment → enqueues" case + the "cluster-self plain Q<n>: reply → integrated" case in tandem.

## Success-Criteria Traceability

The spec's Success Criteria table is a template placeholder. This plan's implicit acceptance targets:

- **SC-001** ("plain Q<n>: from cluster-own account auto-resumes and integrates") → covered by:
  - Monitor: `clarification-answer-monitor-service.test.ts` new case (b).
  - Phase-loop: `clarification-self-answer.test.ts` inverted case at L163.
- **SC-002** ("cluster machine comments still never integrate") → covered by:
  - Monitor: `clarification-answer-monitor-service.test.ts` new case (a).
  - Phase-loop: `clarification-self-answer.test.ts` unchanged case at L120-160 + inverted case at L185.
- **FR-007** ("failure is no longer silent") → covered structurally by the parse-failures flow (existing `phase-loop.ts:1168`). Any same-account comment that would trip the phase loop's parse-failure detection now travels the existing `generacy-clarification-parse-failures:` explainer path (no `viewerDidAuthor === true` short-circuit ahead of it).

## Next Steps

- `/speckit:tasks` to generate task list from this plan.
