# Contract: Answer-scanner flow after #909

**Function**: `integrateClarificationAnswers` in `packages/orchestrator/src/worker/clarification-poster.ts`

**Signature**: unchanged — `(context: WorkerContext, logger: Logger) => Promise<IntegrationResult>`.

## Order of operations (post-fix)

```
1. Resolve spec dir + read clarifications.md
   (unchanged — reason: 'no-spec-dir' | 'no-file')

2. Parse pending questions
   (unchanged — reason: 'no-pending' if all answered)

3. Fetch GitHub issue comments
   (unchanged — reason: 'no-answers' on fetch failure)

──── NEW BEHAVIOR STARTS HERE ────

4. FR-102 marker pre-filter (before trust check):
     scanCandidates = []
     for c of comments:
       markerPrefix = matchClarificationQuestionMarker(c.body)
       if markerPrefix is defined:
         logger.debug({
           event: 'clarification-answer-scanner-marker-excluded',
           commentId: c.id,
           author:    c.author,
           markerPrefix,
           issueNumber,
         }, 'Excluded from answer-scanner via question marker')  // FR-107
         continue
       scanCandidates.push(c)

──── NEW BEHAVIOR ENDS HERE ────

5. Trust check (unchanged — #842):
     for c of scanCandidates:                       // <-- was `comments`
       decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)
       if decision.trusted: trustedComments.push(c)
       else:
         logCommentSkipped(logger, ..., c, decision.reason)
         if commentMatchesAnswerPattern(c.body):
           skippedForExplainer.push(c)

6. Post untrusted-answer explainers for skippedForExplainer
   (unchanged flow, but body copy repaired — see below).
   Note: scanCandidates being marker-filtered means engine-authored
   questions comments can never reach `skippedForExplainer`. This is
   structural — the "misleading explainer against the bot's own
   questions" harm from snappoll#4 is impossible after this change.

7. answerComments = trustedComments
   (was `trustedComments.filter(!isQuestionComment)` — the redundant
    call is dropped because the pre-filter already excluded markers,
    and the content-shape check moves entirely into the parser's
    FR-002 sniff, which is preserved as FR-106 belt-and-suspenders).

8. answers = parseAnswersFromComments(answerComments, pendingNumbers, logger)
   (unchanged — including the FR-002 content sniff at line 478–489
    which continues to catch unmarked question-shaped text as a
    second line of defense).

9. Write answers to clarifications.md
   (unchanged).
```

## Explainer body (FR-104, SC-005, SC-006)

**Function**: `postUntrustedAnswerExplainers` in the same file.

**Before** (line 541–542):

```
> Answers from @${c.author} were not applied (association tier: `${tier}`). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers.
```

**After**:

```
> Answers from @${c.author} were not applied (association tier: `${tier}`). A trusted member (OWNER/MEMBER/COLLABORATOR) must re-post the answers themselves in the `Q1: <answer>` format for the batch to integrate.
```

Assertions:

- Contains: `must re-post`, `OWNER/MEMBER/COLLABORATOR`, `` `Q1: <answer>` `` (backtick-wrapped).
- Contains no substring matching `/confirm(s|ed|ation)?/i`.

## Log-line contract (FR-107, SC-008)

Exactly one debug log line per excluded comment per invocation. Shape (JSON-decoded from a pino stream):

```json
{
  "level": 20,
  "event": "clarification-answer-scanner-marker-excluded",
  "commentId": 4938943909,
  "author": "generacy-ai[bot]",
  "markerPrefix": "<!-- generacy-stage:clarification",
  "issueNumber": 4,
  "msg": "Excluded from answer-scanner via question marker"
}
```

Forbidden fields on this log line: `body`, `content`, `text`, or any full comment content. The predicate does not receive them, the log call site does not pass them.

## `isQuestionComment` contract (`clarification-poster.ts`, exported)

**Signature**: unchanged — `(body: string) => boolean`.

**Behavior after FR-109 delegation**:

- Returns `true` for any body carrying a column-0 FR-101 marker (via `commentCarriesQuestionMarker`).
- Returns `true` for any body matching the `## Clarification Questions` heading pattern (with negative lookahead for `Answers`).
- Returns `true` for any body containing a `### Q<n>:` section that includes `**Question**:`, `**Context**:`, or `**Options**:` (FR-106 content sniff — unchanged).
- Returns `false` otherwise.

Test assertion: for a marker fixture, `isQuestionComment` returns `true` AND — with a spy on `commentCarriesQuestionMarker` — the spy was called. Guards against a future refactor re-inlining the check (regression on FR-109 / SC-007).

## Backward compatibility

- **Callers of `isQuestionComment`**: unchanged signature and semantics; only the internal implementation of the marker branch changes. Existing tests at `__tests__/clarification-poster.test.ts:673–711` continue to pass (they exercise the same input → output relation).
- **Callers of `integrateClarificationAnswers`**: unchanged return shape. `reason: 'no-answers'` becomes the outcome when a batch would previously have produced spurious trust-rejected answers from an engine questions comment — this is the intended behavior improvement.
- **`postClarifications` posting-marker dedup**: unchanged (line 755–765). Its own-marker check on `MARKER_PREFIX` is unrelated to the exclusion set.

## Failure modes and error paths

The pre-filter has no error path (pure string ops). All existing failure modes downstream (`no-spec-dir`, `no-file`, `no-pending`, `no-answers`, `no-changes`) are preserved verbatim.

Log emission is best-effort — if the logger throws, that is a pre-existing project failure mode outside this contract's scope; no wrapping try/catch is added.
