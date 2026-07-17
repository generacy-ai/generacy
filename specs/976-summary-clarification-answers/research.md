# Research: Same-account clarification answers (#976)

## Problem framing

The spec's diagnostic section is exhaustive and the clarification batch pins every open design question. This document captures the small number of judgment calls that remain when translating those answers into a call-site change plan.

## Decision 1: Where to define `MACHINE_MARKERS`

**Choice**: extend `packages/orchestrator/src/worker/clarification-markers.ts` with a new `MACHINE_MARKERS: readonly string[]` alongside the existing `CLARIFICATION_QUESTION_MARKERS` and `CLARIFICATION_ANSWER_MARKERS`. Add sibling `commentCarriesMachineMarker(body)` and `matchMachineMarker(body)` predicates using the same column-0 match rule the other two families use.

**Rationale**: Both call sites (`clarification-poster.ts` and `clarification-answer-monitor-service.ts`) are already within `packages/orchestrator/` and already import from `clarification-markers.ts`. Colocating the new constant with the two existing families keeps the marker vocabulary in one file — future additions (e.g. a new stage:* variant) land in one place. The existing match rule (column-0, case-sensitive ASCII prefix, `> `-quoted excluded) is copied literally so the quote-reply behavior surfaced in `clarification-quote-reply.test.ts` is preserved by construction.

**Alternatives considered**:
- **New file `machine-markers.ts`**. Rejected: two overlapping-topic files in the same directory invite subtle drift. One file with three families keeps the invariant "if it's a marker, it's here" easy to enforce with grep.
- **Extend `CLARIFICATION_QUESTION_MARKERS` in place and rename it**. Rejected: `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` semantically wants the question-only concept (stage/status comments are already filtered by its inline `STAGE_STATUS_REJECT_PREFIXES`), and multiple existing tests in `clarification-markers.test.ts` assert the narrow "question-marker" identity. Broadening the semantics of an existing name breaks those tests without any benefit.
- **Cross-package registry (`@generacy-ai/comment-markers`)**. Rejected: correct long-term shape (see Risk R-2 in `plan.md`), but not required to fix the observed bug and would inflate this PR's blast radius. Tracked as a follow-up.

## Decision 2: Marker match rule (line-anchored, column-0)

**Choice**: reuse the exact existing match rule.

```ts
export function matchMachineMarker(body: string): string | undefined {
  for (const line of body.split('\n')) {
    for (const prefix of MACHINE_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}
```

**Rationale**: Two properties are load-bearing.

1. **Column-0 only.** A `> ` leading quote character means "quoted from another comment", which is exactly how humans answering will surface machine question text (`> <!-- generacy-clarifications:… -->\n> ### Q1: …\nQ1: A`). If the marker matched anywhere in the line, quoting the question would incorrectly exclude the human's plain-text answer that follows. This exact property is asserted for the question family in `clarification-markers.test.ts` and `clarification-quote-reply.test.ts` and MUST hold for the broader family. Copying the rule verbatim guarantees it.

2. **Line-anchored across the whole body.** A comment with the marker on any line (typically line 1, but the parser mustn't depend on that) matches. This lets the marker sit under a leading `\n`-terminated blank prefix or a leading `##` header without breaking the match.

**Alternatives considered**:
- **Match anywhere in the body (substring)**. Rejected — breaks the quoted-reply path.
- **First-line only**. Rejected — some existing families place the marker on line 2 after a title header. Grep confirms all current writers use line-1-column-0, but the parser has always been permissive on line index and there is no upside to tightening.

## Decision 3: `generacy-clarification-answers:` inclusion (marker-relay deprecation)

**Choice**: include `<!-- generacy-clarification-answers:` in `MACHINE_MARKERS`, per Q2=A literal wording. This means `cockpit_relay_clarify_answers`-authored comments are now excluded by the pre-filter at both call sites. The tool's write still succeeds (it posts the comment), but integration no longer picks it up.

**Rationale**: Q2=A explicitly lists this prefix in the exclusion inventory. The whole purpose of #976 is that plain-text answers now flow directly — the marker-relay was a workaround for the exact bug this PR fixes. After the fix, operators (including MCP callers of the tool) can post plain `Q<n>: <answer>` comments and they will integrate. Keeping marker-relay integration alongside the plain path would require carving out an exception in the pre-filter, which contradicts the spec answer.

**Consequences and mitigation**:

- `packages/orchestrator/src/worker/__tests__/clarification-self-answer.test.ts` L185 ("cluster-self answer WITH engine marker → integrated") inverts to `integrated: 0`. Documented in `plan.md` §Project Structure and again in the test's revised docstring.
- `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` (the marker formatter) and `cockpit_relay_clarify_answers.ts` (the MCP tool) are NOT deleted in this PR. External MCP consumers may still call the tool; their calls become no-ops on the integration side but the write itself succeeds. This is a soft deprecation.
- Follow-up: emit a stderr warning from `cockpit_relay_clarify_answers` (or auto-post a marker-free companion) — tracked separately, not blocking. Rationale for splitting: the tool's continued existence is a public MCP contract; deprecation deserves its own PR with release notes, not a piggyback.

**Alternatives considered**:

- **Exclude `generacy-clarification-answers:` from `MACHINE_MARKERS`** (keep marker-relay working). Rejected — deviates from Q2=A's explicit list. The marker-relay path becomes redundant post-fix in any case (plain path works), and asking scanners to treat this marker as "definitely-an-answer" while every sibling marker is "definitely-not-an-answer" mixes semantics.

- **Delete the marker-relay path in this PR**. Rejected — larger scope, has external MCP consumers, and its deletion has no bearing on whether the observed agency#433 bug is fixed. Do the fix, defer the cleanup.

## Decision 4: FR-007 surfacing — `postUntrustedAnswerExplainers` vs. parse-failures explainer

**Choice**: FR-007 is satisfied automatically by the existing `generacy-clarification-parse-failures:` mechanism (`phase-loop.ts:1168`) — the parse-failures flow already emits an explainer comment when an answer that reached the integrator fails to write to `clarifications.md`. No changes to `postUntrustedAnswerExplainers` or the `generacy-untrusted-answer:` family are needed.

**Rationale**: Q3=A names "the existing untrusted-answer explainer comment path (`generacy-untrusted-answer:` family / `postUntrustedAnswerExplainers`)". The wording is slightly imprecise — that specific path is gated on `isTrustedCommentAuthor` returning `trusted: false`, and same-account authors are always trusted (`comment-trust.ts:122` → `reason: 'self-authored'`). So it never fires for the scenario the spec is worried about.

Trace of what actually happens post-fix for the failure cases Q3 is concerned with:

- **Same-account, malformed body, no `Q<n>:` shape**: comment reaches the answer-scanner, `parseAnswersFromComments` returns empty map, `integrateClarificationAnswers` returns `{ integrated: 0, reason: 'no-answers' }`. Phase-loop treats this as "no new answers this poll" — the pause continues but is not silent because the operator can look at `clarifications.md` and confirm no `**Answer**: *Pending*` fields changed. This is the same behavior as a different-account human posting an unparseable comment today; it's not a new silent failure introduced by this PR.

- **Same-account, `Q<n>:` shape present but parse trips `sourceHadQuestionHeadings`**: FR-004 asymmetric fail-close fires. For same-account (`sourceViewerDidAuthor === true`), the whole poll aborts and `integrated: 0, reason: 'aborted-cluster-self-detector'`. The warning at L957-966 IS the surfaced failure (structured `logger.warn`). Not a comment on the issue, but present in cluster logs.

- **Same-account, `Q<n>:` shape present, parse succeeds but a specific question can't be matched to a pending slot**: `parseFailures[]` populated with `reason: 'no-source-comment'` or `'transition-with-question-headings'`. Phase-loop's `renderClarificationParseFailuresComment` fires and posts `<!-- generacy-clarification-parse-failures:<issue> -->`.

The union of these three flows means every failure mode has a surfaced signal (log, log, or explainer comment) — no silent re-arm of `waiting-for:clarification` on a same-account failure. That is the spec's actual requirement per FR-007. Q3=A's mention of `postUntrustedAnswerExplainers` conflates two similar-shaped explainer mechanisms; the parse-failures explainer is the applicable one for trusted-author failures.

**Alternatives considered**:

- **Extend `postUntrustedAnswerExplainers` to also fire for trusted-but-unparseable comments**. Rejected — cross-purposes with the marker's meaning (`generacy-untrusted-answer:` explicitly says trust-tier rejection). Muddying the marker family costs future readability.
- **Introduce a third explainer family (`generacy-clarification-self-parse-failure:`)**. Rejected — no new failure mode to surface. Existing parse-failures explainer already handles the payload.

## Decision 5: Log line churn

**Choice**: delete the `clarification-answer-scanner-self-unmarked` structured log at `clarification-poster.ts:922-930`. Keep `clarification-answer-scanner-marker-excluded` at L857-866, but rename its `reason`-shaped log-message text from `'via question marker'` to `'via machine marker'` — the `markerPrefix` meta field remains and now carries any of the broader family's prefixes.

**Rationale**: The self-unmarked log described a scenario that stops existing post-fix (a cluster-self, trust-cleared, marker-free comment reaching the disjunction). Every previously-logged instance of this event was the bug. Deleting the log line prevents future readers from grep-ing an event name that will never fire again.

**Non-goal**: not adding a new positive log line for the same-account integration path. The existing "Integrated GitHub answers into clarifications.md" log at L1029 covers this — one log per successful integration, independent of author identity.

## Decision 6: `CLARIFICATION_ANSWER_MARKERS` cleanup

**Choice**: leave `CLARIFICATION_ANSWER_MARKERS` and `commentCarriesAnswerMarker` / `matchClarificationAnswerMarker` in `clarification-markers.ts` untouched at the export level. They have no runtime callers post-fix but multiple test files still import them (`clarification-poster-trust.test.ts:279`, `clarification-self-answer.test.ts` uses `clarificationMarker(7)` helper which references the answer marker, `clarification-markers.test.ts` asserts marker semantics).

**Rationale**: Deleting three symbols and updating ~5 test imports is a mechanical cleanup with no behavior impact. This PR is focused on the fix; the cleanup can land later once the marker-relay tool itself is deleted. Grep confirms no cross-package consumers outside test surfaces.

**Consistency invariant**: the answer-marker prefix (`<!-- generacy-clarification-answers:`) appears in TWO constants post-fix — `MACHINE_MARKERS` and `CLARIFICATION_ANSWER_MARKERS`. A comment for future maintainers in `clarification-markers.ts` calls this out: the two are intentionally lockstep, and the answer-marker family will be deleted alongside the marker-relay tool in a follow-up.

## References

- Spec: `specs/976-summary-clarification-answers/spec.md`
- Clarifications: `specs/976-summary-clarification-answers/clarifications.md` (Q1=A, Q2=A, Q3=A, Q4=A, Q5=D)
- Existing marker file: `packages/orchestrator/src/worker/clarification-markers.ts`
- Monitor call site: `packages/orchestrator/src/services/clarification-answer-monitor-service.ts:198-209`
- Phase-loop scanner call sites: `packages/orchestrator/src/worker/clarification-poster.ts:853-870` (pre-filter) and `:916-936` (identity disjunction)
- Trust helper: `packages/workflow-engine/src/comment-trust.ts:122` (`reason: 'self-authored'`)
- Cockpit finder inline list: `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts:15-21`
- Marker-relay tool: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_relay_clarify_answers.ts`
- Marker-relay formatter: `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts`
- Parse-failures explainer (FR-007 target): `packages/orchestrator/src/worker/phase-loop.ts:1168`
- Prior spec: `958-found-during-local-snappoll` (introduced FR-001 / FR-003 — the two gates removed here)
- Prior related fix: `910` (introduced `viewerDidAuthor` field wiring — kept, still consumed by `parseAnswersFromComments` for FR-004 fail-close)
