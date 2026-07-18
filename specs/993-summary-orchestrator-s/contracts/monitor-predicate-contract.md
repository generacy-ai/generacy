# Contract: `ClarificationAnswerMonitorService.processClarificationAnswerEvent` — answer predicate

**Feature**: `993-summary-orchestrator-s`
**Applies to**: `ClarificationAnswerMonitorService.processClarificationAnswerEvent` (`packages/orchestrator/src/services/clarification-answer-monitor-service.ts:156-260`)

## Scope

This contract governs only the "does a candidate answer exist" decision — the loop that today lives at lines 204–212. The surrounding path (precondition checks at 161–178, comment fetch at 185–195, queue construction at 227–247, `enqueueIfAbsent` at 240–247, error handling / logging) is unchanged.

## Signature (unchanged)

```ts
async processClarificationAnswerEvent(
  event: ClarificationAnswerEvent,
): Promise<boolean>
```

Returns `true` iff a `continue` resume queue item was enqueued; `false` on any skip / drop / duplicate path.

## Preconditions (unchanged)

- `event.issueLabels` includes both `waiting-for:clarification` AND `agent:paused`.
- `event.issueLabels` includes no `blocked:*` label.
- `comments = client.getIssueCommentsWithViewerAuth(owner, repo, issueNumber)` succeeded — populated with `author`, `body`, `created_at`, `authorAssociation`, `viewerDidAuthor`. Fetch failure returns `false` early (unchanged).

## Predicate: `candidate = findAnswerCandidate(comments, trustCtx)`

Extract the loop into a private method `findAnswerCandidate(comments: Comment[], trustCtx: CommentTrustContext): Comment | undefined`. Its contract:

### Step 1 — Compute the newness anchor

```
questionAnchor = latestQuestionCommentCreatedAt(comments)
if (questionAnchor === undefined) return undefined
```

Rationale: an issue at `waiting-for:clarification` should *always* have at least one question-marker comment (the clarify phase posts one before applying the label). Absence of a question marker is a data-integrity signal — the monitor MUST NOT resume, because there is nothing to answer. This is the FR-004 short-circuit.

### Step 2 — Scan for the first qualifying answer

Iterate `comments` in the order returned by the client (which is `created_at` ascending per GitHub's default). Return the FIRST comment satisfying all of:

1. `!commentCarriesMachineMarker(c.body)` — machine markers skipped.
2. `!isBotAuthoredLogin(c.author)` — `[bot]`-suffix authors are never answers (FR-001).
3. `c.created_at > questionAnchor` — strict newness (FR-004; ties don't qualify).
4. Either:
   - **(a) marker branch**: `commentCarriesAnswerMarker(c.body)` — see clarifying note in Step 3 about why this branch also requires (2); with the bot filter already applied, the check reduces to "does it carry the answer marker?"
   - **(b) trusted-human branch**: `isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)` returns `{ trusted: true, reason: r }` where `r ∉ { 'bot', 'self-authored' }`.

If no comment satisfies all four, return `undefined`.

### Step 3 — Notes on the trust-reason filter

Excluded reasons and why:

- `reason: 'bot'` — the trust helper returns this when `normalizeLogin(comment.author) === normalizeLogin(ctx.botLogin)`. With the FR-001 upstream `[bot]`-suffix filter, a `[bot]`-suffixed author is already dropped. This reason CAN still fire on a non-`[bot]`-suffixed author whose login matches the resolved cluster account (`ctx.botLogin = 'christrudelpw'`) — i.e., the operator posting from their own PAT-holding account. This is the same-account case, and per snappoll evidence + `viewerDidAuthor === true` semantics, we do NOT count it as an answer here (that path is covered by the phase-loop's `completed:clarification` label integration).
- `reason: 'self-authored'` — the trust helper's `viewerDidAuthor === true` branch. Same rationale: cluster-self comments are integrated via the label path, not this monitor.

Accepted reasons (all imply "a real external human or an approved collaborator"):

- `owner`, `member`, `collaborator` — default-trusted association tiers.
- `widened-tier`, `widened-login` — dead paths for `answer-scanner` per `comment-trust.ts:148` (the surface is pinned to the hard default), but listed here for completeness.

Rejected reasons (all imply "author is not trusted enough to answer"):

- `none-untrusted`, `first-time-contributor-untrusted`, `first-timer-untrusted`, `mannequin-untrusted`, `contributor-untrusted`, `author-association-unset`, `unknown-tier` — the predicate rejects, monitor does not resume.

## Postconditions on `processClarificationAnswerEvent`

- `candidate === undefined` → return `false`. Nothing changes: no queue mutation, no log emission besides the existing `'No trusted human-authored comment found — nothing to resume on'` debug line (repurposed to also cover the FR-004 short-circuit case with a slightly wider message).
- `candidate !== undefined` → construct the `QueueItem` as today (lines 227–237) and call `enqueueIfAbsent`. On success, emit `'Clarification-answer resume enqueued'` info log (unchanged shape).
- The queue-manager side effect is idempotent: if the same issue is polled twice within an in-flight window, `enqueueIfAbsent` returns `false` and the monitor emits the existing `'Dropping clarification-answer enqueue (item already in flight)'` log line.

## Non-behavior (invariants the fix must preserve)

- MUST NOT apply `completed:clarification`. That label is reserved for cluster-relayed answers via the phase-loop path.
- MUST NOT modify `clarifications.md`. The monitor has no checkout.
- MUST NOT clear `waiting-for:clarification` or `agent:paused`. Only the phase-loop transitions those on resume completion.
- MUST NOT call any GitHub write API. Read-only over comments; queue-side effect only.
- MUST NOT change `state.webhooksConfigured`, `state.currentPollIntervalMs`, or any polling behavior. Fix is orthogonal to #987.

## Rejection cases

- Fetch failure on `getIssueCommentsWithViewerAuth` → return `false` (unchanged path at 189–195). No retry within the same poll cycle.
- `trustConfig` load failure → falls back to the trust helper's hard default. `tryLoadCommentTrustConfig` swallows ENOENT (missing config file is the norm), so this rarely fails; a real parse error is logged and the trust helper uses the hard default (which excludes `answer-scanner` from any widening — line 148 of comment-trust.ts). The monitor doesn't have to distinguish.

## Test cases (informative — reference for the tasks phase)

### SC-001: bot-only comments, zero resumes

```
fixture:
  question marker author = generacy-ai[bot], created_at = 2026-07-18T10:00:00Z
  spec-summary author    = generacy-ai[bot], created_at = 2026-07-18T09:00:00Z
  speckit-stage-clarify  = generacy-ai[bot], created_at = 2026-07-18T09:59:00Z
run:
  processClarificationAnswerEvent(seed)  x N poll cycles
assert:
  return value === false on every cycle
  queueManager.enqueueIfAbsent  NOT called
```

### SC-002: bot noise + one real human answer, exactly one resume

```
fixture:
  question marker author = generacy-ai[bot],  created_at = 2026-07-18T10:00:00Z
  spec-summary author    = generacy-ai[bot],  created_at = 2026-07-18T09:00:00Z
  speckit-stage-clarify  = generacy-ai[bot],  created_at = 2026-07-18T09:59:00Z
  human answer body      = author 'christrudelpw', authorAssociation 'MEMBER',
                           created_at = 2026-07-18T10:15:00Z, body without any marker
run:
  processClarificationAnswerEvent(seed)  x 1 poll cycle
assert:
  return value === true
  queueManager.enqueueIfAbsent called once with command 'continue'
```

### SC-003: non-bot marker-carrying answer

```
fixture:
  question marker author = generacy-ai[bot], created_at = 2026-07-18T10:00:00Z
  answer marker author   = 'humantester', authorAssociation 'MEMBER',
                           created_at = 2026-07-18T10:15:00Z,
                           body contains '<!-- generacy-clarification-answers:1 -->\nQ1: yes'
run:
  processClarificationAnswerEvent(seed)  x 1 poll cycle
assert:
  return value === true
  queueManager.enqueueIfAbsent called once
```

### SC-N: no question marker on issue → false

```
fixture:
  human answer body      = author 'christrudelpw', authorAssociation 'MEMBER',
                           created_at = 2026-07-18T10:00:00Z
  (no question marker comment at all)
assert:
  return value === false
  queueManager.enqueueIfAbsent  NOT called
```

### SC-N: `viewerDidAuthor === true` on non-`[bot]` author does not qualify

```
fixture:
  question marker author = generacy-ai[bot], created_at = 2026-07-18T10:00:00Z
  self-authored answer   = author 'christrudelpw', authorAssociation 'MEMBER',
                           viewerDidAuthor = true,
                           created_at = 2026-07-18T10:15:00Z
assert:
  return value === false
  (isTrustedCommentAuthor returns reason 'self-authored', which the predicate excludes)
```

### SC-N: same `created_at` as question → tie does not qualify

```
fixture:
  question marker author = generacy-ai[bot],   created_at = 2026-07-18T10:00:00Z
  candidate answer       = author 'humantester', authorAssociation 'MEMBER',
                           created_at = 2026-07-18T10:00:00Z
assert:
  return value === false
  (strict > required by FR-004)
```
