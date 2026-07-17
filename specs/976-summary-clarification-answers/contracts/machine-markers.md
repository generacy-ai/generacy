# Contract: `MACHINE_MARKERS` and the two call sites

Load-bearing invariants for #976. Both the monitor and the phase-loop scanner MUST honor these behaviors; divergence reintroduces the observed agency#433 bug (monitor auto-resumes on a plain reply but phase loop drops the answer, or vice-versa).

## Constant: `MACHINE_MARKERS`

Location: `packages/orchestrator/src/worker/clarification-markers.ts`.

### Inventory (fixed by spec Q2=A)

```ts
export const MACHINE_MARKERS: readonly string[] = [
  // Question-family (spread from CLARIFICATION_QUESTION_MARKERS — superset invariant)
  '<!-- generacy-stage:clarification',
  '<!-- generacy-clarifications:',
  '<!-- generacy-clarification:',
  '<!-- generacy-cockpit:clarifications-batch:',

  // Stage/status comments
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:implementation',

  // Audit / lifecycle bot comments
  '<!-- generacy-cockpit:manual-advance',

  // Answer-relay marker (deprecates cockpit_relay_clarify_answers integration path)
  '<!-- generacy-clarification-answers:',

  // Bot-authored explainer / diagnostic comments
  '<!-- generacy-untrusted-answer:',
  '<!-- generacy-clarification-parse-failures:',
] as const;
```

### Match rule

Copied verbatim from `matchClarificationQuestionMarker`:

```
matchMachineMarker(body):
  for each line in body.split('\n'):
    for each prefix in MACHINE_MARKERS:
      if line.startsWith(prefix):
        return prefix
  return undefined
```

- **I-M1** Case-sensitive ASCII prefix match. `'<!-- GENERACY-STAGE:planning'` does not match.
- **I-M2** Column-0 anchoring. Any leading whitespace (space, tab) or `> ` quote disqualifies.
- **I-M3** Line-anchored across the entire body. The marker can appear on any line, not just line 1.
- **I-M4** Returns the specific matched prefix identity (not `true`) — enables structured logging with `markerPrefix` at the call sites.
- **I-M5** Superset invariant: every element of `CLARIFICATION_QUESTION_MARKERS` is also in `MACHINE_MARKERS`.
- **I-M6** No entry is a prefix of another entry. Enforced by test; guards a future addition from over-matching a shorter prefix.

### Structural test coverage

`clarification-machine-markers.test.ts` MUST assert:

1. Every entry in the inventory positively matches on a comment body containing that entry at column 0. (Parameterized loop.)
2. A `> `-quoted marker returns `undefined`.
3. A leading-whitespace marker returns `undefined`.
4. A body containing marker-shaped prose without a `<!--` wrapper returns `undefined`.
5. `CLARIFICATION_QUESTION_MARKERS.every(m => MACHINE_MARKERS.includes(m))`.
6. No prefix-of-another-prefix violations.

## Call-site contract: Monitor

Location: `packages/orchestrator/src/services/clarification-answer-monitor-service.ts::processClarificationAnswerEvent` (comment-iteration loop at L198-209).

### Pre-filter step

For each fetched comment `c`:

```
if commentCarriesMachineMarker(c.body):
  continue     // skip; do not consider for enqueue

decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)
if decision.trusted:
  hasHumanTrustedComment = true
  break
```

### Invariants

- **I-Mon1** No `viewerDidAuthor === true` short-circuit. Same-account trust decisions are delegated entirely to `isTrustedCommentAuthor` (which returns `trusted: true` with `reason: 'self-authored'` for self-authored comments per `comment-trust.ts:122`).
- **I-Mon2** MUST call `commentCarriesMachineMarker` (not `commentCarriesAnswerMarker`, not `commentCarriesQuestionMarker`). The broader set is load-bearing — narrower filters let stage/status/audit comments through and produce spurious enqueues.
- **I-Mon3** No side effects during comment iteration beyond the `hasHumanTrustedComment` flag. No label writes, no comment writes, no queue writes.
- **I-Mon4** Enqueue decision (unchanged from #958): `enqueueIfAbsent` with `command: 'continue'`, `queueReason: 'resume'`, workflow derived from `workflow:*` label.
- **I-Mon5** Never applies `completed:clarification` (unchanged contract from #958 monitor).

### Test coverage (`clarification-answer-monitor-service.test.ts`)

Positive: same-account plain `Q1: OAuth` comment → `enqueueIfAbsent` called once with `command: 'continue'`.

Negative parameterization (every prefix from `MACHINE_MARKERS`): same-account comment with that prefix at column 0 → `enqueueIfAbsent` not called.

Existing #958 cases (different-account human, preconditions, blocked:*, in-flight dedupe, no labels applied) — unchanged, still pass.

## Call-site contract: Phase-loop scanner

Location: `packages/orchestrator/src/worker/clarification-poster.ts::integrateClarificationAnswers` (pre-filter L853-870, answer-comment assembly L916-936).

### Pre-filter step (L853-870)

For each fetched comment `c`:

```
markerPrefix = matchMachineMarker(c.body)
if markerPrefix is not undefined:
  logger.debug({ event: 'clarification-answer-scanner-marker-excluded', ..., markerPrefix }, ...)
  continue
scanCandidates.push(c)
```

### Trust step (L883-897) — UNCHANGED

Each `scanCandidate` goes through `isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)`. Untrusted authors are collected into `skippedForExplainer` if their body matches `commentMatchesAnswerPattern`, and the existing `postUntrustedAnswerExplainers` path fires for them.

### Candidate assembly step (L916-936)

```
answerComments = trustedComments      // every trusted, marker-free comment is a candidate
```

No `viewerDidAuthor === true` disjunction. No conditional based on marker family (the pre-filter already handled that).

### Downstream parsing (UNCHANGED)

`parseAnswersFromComments(answerComments, pendingNumbers, logger)` runs as today. Each parsed answer carries `sourceViewerDidAuthor` — this field is used by FR-004 fail-close at L951-988 to decide abort-vs-skip on a same-account comment that tripped `sourceHadQuestionHeadings`. That logic is unchanged.

### Invariants

- **I-Post1** No identity-based candidacy gate. Every trusted, marker-free comment is a candidate answer.
- **I-Post2** MUST call `matchMachineMarker` at the pre-filter (not `matchClarificationQuestionMarker`). Narrower filter reintroduces the bug for stage/status/audit comments (though those don't typically match `Q<n>:` shape, they could confuse future parsers).
- **I-Post3** FR-004 asymmetric fail-close on `sourceHadQuestionHeadings` is retained. Same-account (`sourceViewerDidAuthor === true`) → whole-poll abort; different-account (`false`/`undefined`) → skip that one question only.
- **I-Post4** The `clarification-answer-scanner-self-unmarked` log event at L922-930 MUST be deleted. Zero grep hits after this PR.
- **I-Post5** The `clarification-answer-scanner-marker-excluded` log event at L857-866 is retained; its message text updates to `'Excluded from answer-scanner via machine marker'`; its `markerPrefix` meta field now carries any of the broader family.

### Test coverage (`clarification-poster.test.ts`, `clarification-self-answer.test.ts`)

Positive: same-account plain `Q1: OAuth 2.0` reply → `integrated: 1`, `mockWriteFileSync` called with body containing `**Answer**: OAuth 2.0`.

Negative parameterization: same-account comment with each `MACHINE_MARKERS` prefix at column 0 → `integrated: 0` (excluded at pre-filter). Specifically for `<!-- generacy-clarification-answers:`, this codifies the deprecation of the marker-relay integration path.

FR-004 fail-close preservation: same-account comment with `### Q<n>:` headings → `integrated: 0`, `reason: 'aborted-cluster-self-detector'` (unchanged).

Quote-reply preservation: `> `-quoted marker in an otherwise-plain answer body → integrates the answer, marker line has no effect (unchanged, covered by existing `clarification-quote-reply.test.ts`).

## FR-007 surfacing contract

Failure surfacing is delegated to existing infrastructure. This feature MUST NOT introduce a new explainer marker family or a new label.

- **Trusted same-account, malformed body, no `Q<n>:` shape** → `IntegrationResult { integrated: 0, reason: 'no-answers' }`. Phase loop treats as "no new answers"; not counted as a silent re-arm (operator can inspect `clarifications.md` to see no `**Answer**: *Pending*` changed).
- **Trusted same-account, `Q<n>:` shape, `sourceHadQuestionHeadings === true`** → whole-poll abort, structured `logger.warn` with code `TRANSITION_WITH_QUESTION_HEADINGS`, `IntegrationResult { integrated: 0, reason: 'aborted-cluster-self-detector' }`. Log line is the surfaced failure.
- **Trusted same-account, `Q<n>:` shape, parse-failure per-question** → `parseFailures[]` populated in `IntegrationResult`. Phase-loop's `renderClarificationParseFailuresComment` (`packages/orchestrator/src/worker/phase-loop.ts:1168`) posts `<!-- generacy-clarification-parse-failures:<issue> -->` explainer to the issue.

Together, these three paths cover every same-account failure mode with either a log line (loud) or an issue comment (loudest). Q3=A's mention of `postUntrustedAnswerExplainers` is imprecise wording for "some existing explainer path" — the parse-failures explainer is the applicable one for trusted-author failures (`postUntrustedAnswerExplainers` is trust-tier rejection and never fires for same-account, which is always trusted).

## Cross-surface consistency

`packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts:15-21` has its own inline `STAGE_STATUS_REJECT_PREFIXES` list. It overlaps with `MACHINE_MARKERS` but is intentionally not unified in this PR — the cockpit finder answers a different question (which comment to relay to the human) and lives on the CLI side of the process boundary. If a future PR adds a marker family, both surfaces must be updated. Follow-up: cross-package marker registry (out of scope for #976).

## Non-goals (explicit)

- Not adding a config flag (`clusterIdentityIsHuman` or similar). Q1=A rejects config-based approaches.
- Not classifying cluster login as human vs. bot. Q1=A / Q5=D reject identity classification.
- Not deleting the marker-relay tool or its formatter. Soft-deprecation only.
- Not touching `comment-trust.ts` or the trust helper's tiers. Trust semantics unchanged.
- Not unifying with `clarification-comment-finder.ts` inline list. Cross-package refactor deferred.
- Not renaming existing marker prefixes. Every string is stable and load-bearing for GitHub-side idempotence via marker dedup.
