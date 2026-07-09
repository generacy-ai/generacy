# Research: Cluster-identity trust + zero-trusted loud retention + dedupe-on-exit

**Feature**: `869-found-during-cockpit-v1`
**Date**: 2026-07-09

## R1. Where the four sub-defects live in code

### R1.1 Sub-defect 1 (trust set omits cluster identity) — FR-001

**Location**: `packages/workflow-engine/src/security/comment-trust.ts`, function `isTrustedCommentAuthor`, decision 1 (line ~76).

Current shape:
```typescript
if (ctx.botLogin && comment.author === ctx.botLogin) {
  return { trusted: true, reason: 'bot' };
}
```

`ctx.botLogin` is derived by the handler as `process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME']` (`pr-feedback-handler.ts:147`). This intentionally covers *two* legs of the #830 chain but misses the third (`gh api user`). The handler's env-var access also races startup — the same value is authoritative on `resolveClusterIdentity()` output stored on the service, but not exposed to the handler.

**Fix**: add `clusterIdentity?: string` to `CommentTrustContext` (the same field name would work but signals intent clearly). Callers pass in the resolved identity (already computed at orchestrator startup via `resolveClusterIdentity`). Predicate treats it as a trusted-login match with a new `TrustReason: 'cluster-identity'`.

**Rationale for a separate reason code**: SC-005's grep audit is easier when we can see "trusted because cluster identity" distinct from `'bot'` (which is more general). Also, the observability payload the handler already emits in the skip-log gains diagnostic value.

**Rejected**: reuse `botLogin` field directly.
Why rejected: `botLogin` semantics in #842 were "the resolved bot GitHub App identity for prompt-injection defense", not "the acting operator identity". Overloading dilutes the field's meaning. Two clean fields, two clean reasons.

### R1.2 Sub-defect 2 (silent success on zero-trusted) — FR-002/FR-003/FR-004

**Location**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:196-203`.

Current shape:
```typescript
if (unresolvedComments.length === 0) {
  this.logger.info(
    { prNumber, issueNumber },
    'No unresolved threads found — removing label and exiting',
  );
  await this.removeFeedbackLabel(...);
  return;
}
```

Note the log line is *false*: the immediately-preceding block logs `unresolvedThreads: N` where N > 0 and only `trustedUnresolvedComments: 0`. This is the SC-002 "0 occurrences" line the spec calls out.

**Fix**: split the branch. If `unresolvedThreads.length > 0` **and** `trustedUnresolved.length === 0`, take the *retention* branch: warn with author details, do NOT remove the label, DO clear the dedupe key (FR-006), return.

Under Q1-A's shared-predicate design the monitor filters upstream and this branch becomes a race-window backstop (comment edited/deleted between poll and claim). The handler still needs to handle it because the race is real.

### R1.3 Sub-defect 3 (monitor/handler disagree) — FR-005

**Location**:
- Monitor: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:167-193` (extracts only `rootCommentId` per unresolved thread, never inspects authors).
- Handler: `pr-feedback-handler.ts:143-176` (runs `isTrustedCommentAuthor` per comment).

**Fix**: monitor already calls `getPRReviewThreads` which under the hood requests `author { login }` and `authorAssociation` on every comment. The projection at line 173 discards this. Change the projection to keep per-thread comment lists, run `isTrustedCommentAuthor` on each with `{ botLogin, clusterIdentity, config }`, and count trusted vs. untrusted per thread. A thread with *any* trusted unresolved comment stays in the enqueue set; a thread with only untrusted unresolved comments is filtered out.

**Rejected**: change `GhCliGitHubClient.getPRReviewThreads` return shape.
Why rejected: the client already returns full `Comment[]` per thread (lines 551-573 of `gh-cli.ts`). The monitor was throwing away information. Just stop throwing it away.

### R1.4 Sub-defect 4 (dedupe never cleared on non-standard exits) — FR-006

**Location**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:196-291`.

Current shape: `phase-tracker:*:address-pr-feedback` is set by `PrFeedbackMonitorService.tryMarkProcessed()` (line 231) at enqueue. The handler *never* calls `phaseTracker.clear()`. Exit paths:

1. Success (`success=true` at line 273 → label removed) → key NOT cleared (24h TTL rescue).
2. Zero-trusted current path (`unresolvedComments.length === 0` at line 196 → label removed) → key NOT cleared.
3. CLI failed/timeout (`else` at line 279 → label kept) → key NOT cleared.
4. Uncaught exception (throw at line 290) → key NOT cleared.

The three "label kept" paths self-heal because next poll re-detects and (b) the dedupe-check ordering means the same enqueue is intended to be skipped as duplicate. The two "label removed" paths *should* clear the key: once the label is removed, the monitor won't re-detect until a new event, but the key sits marked. This is fine for path (1) (nothing to re-detect anyway) and disastrous for path (2) (the state that was silently discarded).

**Fix**: give the handler the `PhaseTracker` reference (currently absent) and call `phaseTracker.clear(owner, repo, issueNumber, 'address-pr-feedback')` on every terminal exit path: success, zero-trusted retention, and *inside* the outer `catch` block (line 285) before re-throw. Per Q3-A, "every terminal exit" includes all exception classes.

**Injection point**: `PrFeedbackHandler` constructor currently takes `(config, logger, agentLauncher, sseEmitter)`. Add `phaseTracker: PhaseTracker` as fifth arg. Wiring in `claude-cli-worker.ts:265` receives it from `ClaudeCliWorkerDeps`. `#849` already added `phaseTracker` as an optional `ClaudeCliWorkerDeps` field (see `CLAUDE.md`) — reuse that plumbing.

### R1.5 Q4 degraded path — FR-007

**Location**: same handler. Currently the handler reads `process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME']` directly (line 147). It never calls `gh api /user`. So today, on a wizard cluster where the env vars are unset but `gh` is authenticated, the third chain link is never tried and identity silently fails to resolve.

**Fix**: hand the resolved identity down from the orchestrator's startup path (where `resolveClusterIdentity` already runs and gives `LabelMonitorService` its `clusterGithubUsername`). Add it to `WorkerConfig` (already has `credentialRole` — same pattern) or to `ClaudeCliWorkerDeps`. Handler passes it into `CommentTrustContext.clusterIdentity`. On `undefined`, log at `error` naming the tried chain and continue.

## R2. Deciding where the FR-004 notice is posted

Per Q1-A + Q5-A, the notice moves to the **monitor** and is a **top-level PR comment**.

### R2.1 Idempotency mechanism (Q2-A)

Marker: `<!-- generacy:pr-feedback-untrusted-notice -->` in the comment body. Before posting, run `gh pr view <n> --json comments --jq '.comments[].body'`, grep for the marker string, skip if present. This mirrors the codebase's existing pattern (`<!-- generacy-stage:… -->`, `<!-- cockpit -->` per #865).

### R2.2 State-transition detection

The monitor already has `private lastUnresolvedThreadCount: Map<string, number>` (line 54). Add a sibling `private lastZeroTrustedTransition: Map<string, boolean>` keyed on the same `${owner}/${repo}#${prNumber}`. On each poll:
- If `unresolvedThreads > 0` **and** `trustedUnresolvedComments === 0`, and previous state was NOT the same (or was undefined), that's the transition edge — post the notice (marker-checked). Set to `true`.
- If either count changes back (trusted appears, or unresolved drops to 0), reset to `false`.

**Rejected alternative**: post on every poll and rely purely on marker-grep.
Why rejected: even though marker-grep prevents duplicate posts, it means every poll cycle spends one extra `gh pr view` call on every zero-trusted PR. The transition-tracker adds one boolean per open PR (bounded, monitor-lifetime) to avoid the wasteful grep.

The map is intentionally not persisted — a monitor restart re-triggers the notice (idempotency-safe via the marker), so no correctness loss.

## R3. Sequencing with #862 (dedupe redesign)

#862 is in flight (see `CLAUDE.md` — `Pause-Paired Resume-Dedupe Clear (#849)`). It redesigns the key layout / TTL semantics but does not itself decide *when* keys are cleared on the PR-feedback flow.

FR-006's invariant ("cleared on all terminal exit paths") is layered on top of whatever `PhaseTracker` implementation is present. Q3-A commits us to that invariant; when #862 lands, the invariant translates directly.

**Nothing in #869 blocks or is blocked by #862** — the two changes touch different call sites and can land in either order.

## R4. Test surface

### R4.1 Unit — `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`

New cases:
- Comment authored by `clusterIdentity` login, `author_association: NONE` → `{ trusted: true, reason: 'cluster-identity' }`.
- Comment authored by `clusterIdentity` login, `author_association: OWNER` → `{ trusted: true, reason: 'owner' }` (tier match wins; cluster-identity match is decision-3 in the order, tier match is also decision-3 — validated below).
- `clusterIdentity: undefined` + previously bot-login-matching author → unchanged behavior (bot decision fires).
- `clusterIdentity` set but not matching + tier untrusted → `{ trusted: false, reason: 'none-untrusted' }` (unchanged).

**Decision order tie-break**: cluster-identity check is placed at decision 1.5 (between botLogin and the tier lookup) — a cluster-identity match is trusted *regardless* of `author_association`, mirroring the botLogin decision. This matches the FR-001 spec text ("either association ∈ {…} OR author.login == cluster identity") and the sub-defect-1 reality (the observed `author_association: NONE`).

### R4.2 Unit — `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`

New cases:
- Unresolved thread with only cluster-identity author → enqueue proceeds, notice NOT posted.
- Unresolved thread with only untrusted authors, no previous state → enqueue skipped, notice posted with marker.
- Unresolved thread with only untrusted authors, marker already in PR comments → enqueue skipped, notice NOT re-posted.
- Unresolved thread with only untrusted authors, previous state already zero-trusted → enqueue skipped, notice NOT re-posted (transition-map guard).
- Trusted comment appears on next poll after zero-trusted state → enqueue proceeds, transition-map resets.

### R4.3 Unit — `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`

New cases:
- Success path → `phaseTracker.clear()` invoked with the expected key.
- Zero-trusted retention path (race — monitor claimed with trusted, then comment edited to untrusted before handler runs) → label retained, `warn` log emitted, `phaseTracker.clear()` invoked.
- Uncaught exception (e.g., `github.getPullRequest` throws) → `phaseTracker.clear()` invoked *before* re-throw.
- Transient error (thread-fetch throws `ETIMEDOUT`) → `phaseTracker.clear()` invoked (Q3-A: all exceptions).
- `clusterIdentity: undefined` + only-untrusted comments → `error` log naming chain links, FR-002/FR-003 applied.

### R4.4 Integration — `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts`

Replay the christrudelpw/sniplink#4 / PR #14 scenario:
- Fixture PR review with one inline comment authored by the resolved cluster identity, `author_association: NONE`.
- Assertion: monitor enqueues (`PR feedback work enqueued`), handler routes to `PrFeedbackHandler`, `comment-skipped … reason=none-untrusted` line is NOT in the log capture.

## R5. Alternatives considered end-to-end (and dropped)

| Alternative | Why dropped |
|-------------|-------------|
| Ship only FR-006 (clear dedupe on all exits) — leave trust semantics alone | Spec §"Why this is structural" — with dedupe fixed and (1, 3) unfixed, monitor+handler form an enqueue/skip busy-loop. Dedupe fix without trust-set fix is worse than status quo. |
| Documented asymmetry (Q1-B) — monitor over-enqueues, handler owns all trust | The spec's §"decreasing severity" ranks (3) below (1) but above (4); Q1-A calls out the specific concrete cost — each refused claim is a worker startup, branch checkout, and dedupe-mark that #862 will have to also clean up. Also, non-shared predicates are the exact class of drift that produced #842's original ingress-surface diversity. |
| Redis notice-dedupe key (Q2-B) | Machinery #862 will delete. |
| 1-per-poll notice noise (Q2-C) | Trains operators to ignore the notice. |
| Drop FR-004 entirely (Q2-D) | Removes the only operator-visible surface of the zero-trusted state — leaves the failure mode where the operator has to know to check logs. |
| Distinguish transient vs. permanent exceptions (Q3-C) | Extra classification helper on the dedupe path #862 will delete. |
| Reply on each unresolved thread + suppress the bot's own notice via marker (Q5-B) | Adds a targeted skip rule to `isTrustedCommentAuthor` — the exact function whose subtlety caused this bug. Grows the trust predicate's rule set. |
| Resolve the thread from the bot after posting the notice (Q5-C) | Destroys the operator's unresolved-conversations signal. Explicitly rejected in spec §"Out of Scope". |

## R6. Sources

- Spec: `specs/869-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/869-found-during-cockpit-v1/clarifications.md`
- Sibling specs: #842 (trust filter), #861 (thread-shaped client), #862 (dedupe redesign in flight), #849 (paired resume-dedupe clear pattern).
- Live incident: christrudelpw/sniplink#4 / PR #14 — see spec §"Observed" for the log timeline.
- Repo pattern references (per Q2-A): grep for `<!-- generacy-` and `<!-- cockpit -->` markers across `packages/` for prior art.
