# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #31

**Branch**: `869-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #31. First live end-to-end run of the #861-fixed PR-feedback loop — it worked at every stage and then defeated itself at the last one.

## Observed (christrudelpw/sniplink#4 / PR #14)

The operator selected request-changes at the cockpit implementation-review gate; the cockpit posted an `event: COMMENT` review with one inline anchored comment on PR #14 — authored, necessarily, by the **cluster's own GitHub identity** (the App/bot account that opens every PR). Then:

1. **Monitor (orchestrator)**: `Found 1 unresolved review thread(s)` → atomically marked `phase-tracker:christrudelpw:sniplink:4:address-pr-feedback` → `PR feedback work enqueued`. ✅ (#861 works live.)
2. **Worker**: claimed the item, routed to `PrFeedbackHandler`, switched to the branch. ✅
3. **Trust filter (#842)**: 
   ```
   event=comment-skipped surface=pr-feedback commentId=3547855420 author=generacy-ai authorAssociation=NONE reason=none-untrusted
   ```
   GitHub reports `author_association: NONE` for the App identity, so the handler discarded the only comment in the thread.
4. **Zero-trusted exit**: `totalComments:1, unresolvedThreads:1, trustedUnresolvedComments:0` → logged `"No unresolved threads found — removing label and exiting"` → removed `waiting-for:address-pr-feedback` → `PR feedback addressing completed` → worker exits **success**.
5. **Wedge**: the dedupe key from step 1 is never cleared on this exit path, so every subsequent poll logs `Duplicate detected (atomic check) … Skipping duplicate` while the unresolved thread objectively persists. The loop is dead for this PR until the key's TTL expires.

## Why this is structural, not a tuning miss

**Two safety features are mutually deadlocked.** #842's author-trust filter (correct: don't let arbitrary commenters steer agents) and the cockpit's request-changes path (correct: agent-actionable feedback = inline threads, posted via the cluster's gh) are each right alone; composed, the pipeline's *primary first-party payload* — feedback originating from the cockpit's own human-approved gate — is classified as untrusted prompt-injection and discarded. As shipped, the feedback loop can only ever act on comments hand-authored by a repo OWNER/MEMBER/COLLABORATOR; the flow the cockpit itself generates can never be auto-addressed. (Live confirmation: the operator's only recourse was to reply to the thread by hand from a personal account.)

Four sub-defects, decreasing severity:

1. **Trust set omits the cluster's own identity.** The handler already resolves that identity (the #830 chain: config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`). Trust should be `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` **∪ {resolved cluster identity}**. A comment the cluster posted through its own human-gated cockpit surface is first-party by definition.
2. **Zero-trusted ≠ zero-unresolved, but the handler conflates them.** "Unresolved threads exist but none are trusted" must not remove the label, log "No unresolved threads found" (the line is false — its own fields say `unresolvedThreads:1`), and exit success. It should keep or re-flag state, log at `warn` with the skipped authors/reasons, and ideally post the #842-style bot notice ("feedback present but not from a trusted author — reply from a maintainer account to proceed"). Silent-success here is the same fail-silent class as #861's original bug.
3. **Monitor and handler disagree on the trust predicate.** The monitor enqueues on *any* unresolved thread (no trust filter); the handler then declares the work nonexistent. The same predicate should gate both ends — otherwise the monitor perpetually manufactures work the handler refuses (see 4).
4. **The dedupe key wedges the retry path.** Marked at enqueue, never cleared on the zero-trusted exit → permanent skip until TTL. Third live instance of the history-keyed-dedupe stranding class (#849, #862); #862's in-flight redesign subsumes this case, but note the interaction: with dedupe fixed and 3 unfixed, monitor+handler become an enqueue/skip busy-loop — which is why 1 and 3 are the real fix and 4 alone is insufficient.

## Regression tests

- Review comment authored by the resolved cluster identity (`author_association: NONE`) on an unresolved thread → processed, not skipped.
- Unresolved threads present, all authors untrusted → label retained (or explicit paused state), `warn` log naming skipped authors, non-silent outcome; no "No unresolved threads" wording.
- Monitor and handler evaluate the same thread set through the same trust predicate (shared function), or the asymmetry is explicitly documented and bounded.
- Handler exit on any path clears/settles the enqueue-dedupe state such that a later new trusted comment re-triggers the loop.

## Repro state left in place

No manual repair applied to the loop (deliberately — evidence): PR #14's thread is unresolved, `waiting-for:address-pr-feedback` was auto-removed, and `phase-tracker:christrudelpw:sniplink:4:address-pr-feedback` is still marked, with the monitor logging `Skipping duplicate` each poll. Branch `004-phase-1-foundation-part` separately had its base-merge conflicts repaired (commit `363f918`) — unrelated to this finding, tracked by #864.


## User Stories

### US1: Operator's request-changes review reaches the worker

**As a** cockpit operator who selected request-changes at the implementation-review gate,
**I want** the inline review comments the cockpit posts through the cluster's own GitHub identity to be treated as first-party feedback,
**So that** the #861 PR-feedback loop actually addresses the changes I asked for instead of silently dropping them and stranding the PR.

**Acceptance Criteria**:
- [ ] A review comment authored by the resolved cluster identity (with `author_association: NONE`) on an unresolved thread of a PR the cluster opened is processed by the PR-feedback worker (not skipped by the #842 trust filter).
- [ ] When unresolved threads exist but every comment author is untrusted, the handler retains `waiting-for:address-pr-feedback`, emits a `warn` log naming the skipped authors and `authorAssociation` values, and does not print the "No unresolved threads found" line.
- [ ] The enqueue-dedupe key (`phase-tracker:<owner>:<repo>:<pr>:address-pr-feedback`) is settled on every terminal exit of the handler — success, zero-trusted retention, and caught exception — so a later state change re-triggers the loop instead of hitting TTL.

### US2: Untrusted-only state is visible on the PR

**As a** cockpit operator watching a PR whose only review-thread comments are untrusted,
**I want** a single bot-authored top-level PR comment explaining that the feedback is present but the handler will not act until it comes from a trusted author,
**So that** I know to reply from a maintainer account (or reconfigure the cluster identity) instead of assuming the loop is silently working.

**Acceptance Criteria**:
- [ ] Exactly one notice is posted per zero-trusted episode (idempotent via hidden HTML marker, checked against prior PR comments before posting).
- [ ] The notice is a top-level PR comment (`gh pr comment`), not a review-thread reply — so it never re-enters the unresolved-thread scan and cannot form a self-trust loop with FR-001.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Trust predicate accepts a comment as trusted when either `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` **or** `author.login == resolved cluster identity`. Identity resolution reuses the #830 chain (config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`). | P0 | Fixes sub-defect 1 (observed live on PR #14). |
| FR-002 | When unresolved threads exist and every author is untrusted, the handler retains `waiting-for:address-pr-feedback` and exits without removing the label. No "No unresolved threads found" log line on this path. | P0 | Fixes sub-defect 2. Non-silent outcome is load-bearing. |
| FR-003 | On the zero-trusted retention path, the handler emits a `warn` log naming each skipped comment's author login, `authorAssociation`, and the reason (`none-untrusted`). | P0 | Companion to FR-002; operator diagnosability. |
| FR-004 | On the transition into the zero-trusted state, a single top-level PR comment is posted via `gh pr comment` explaining that feedback is present but untrusted and that a maintainer must reply to proceed. Idempotency: a hidden HTML marker (`<!-- generacy:pr-feedback-untrusted-notice -->`) is grep-checked against prior PR comments before posting; one notice per episode; old notices are left in place as audit trail (not edited or deleted on exit). Under Q1's shared-predicate design, the notice is posted by the **monitor** at the state transition it already detects, not by the handler. | P1 | Placement chosen (top-level, not review-thread reply) to structurally prevent the self-trust loop that FR-001's expanded trust set would otherwise create. |
| FR-005 | Monitor and handler evaluate thread trust through a **single shared predicate** (`isTrustedCommentAuthor`) exported from the same module as `getPRReviewThreads` (from #861). The monitor's GraphQL query is extended to pull `author.login` + `authorAssociation` per comment; unresolved threads whose comments are all untrusted are not enqueued. FR-002/FR-003 loud retention stays in the handler as a defense-in-depth fallback for races (comment edited/deleted between poll and claim). | P0 | Fixes sub-defect 3. |
| FR-006 | The enqueue-dedupe key is cleared on every terminal handler exit: success, zero-trusted retention, and caught exception (all exception classes — transient and permanent). Rationale: fail-loud-and-retry beats fail-silent-and-strand; busy-loop risk on persistent failure is bounded by the monitor's 60s poll cadence and is diagnosable, unlike the TTL strand this fix closes. Forward-compatible with #862's dedupe redesign. | P0 | Fixes sub-defect 4. |
| FR-007 | When the cluster identity resolution chain returns nothing at runtime, the handler logs the failure at `error` level naming each chain link tried (`config`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`, `gh api user`) and then continues to apply FR-002/FR-003/FR-004 unconditionally to any untrusted comments observed. Association-trusted comments are still processed normally. No new error class is introduced; the worker is not marked failed. | P1 | Prevents identity-unresolvable degradation from silently re-opening the sub-defect-2 wound. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cockpit request-changes reaches the worker end-to-end | 100% of request-changes reviews posted through the cockpit result in the worker claiming, addressing, and pushing a follow-up commit within one poll cycle of the review being submitted | Replay of the christrudelpw/sniplink#4 / PR #14 scenario (or equivalent test double); assert log sequence contains `PR feedback work enqueued` → `PrFeedbackHandler` claim → new commit pushed; no `comment-skipped … reason=none-untrusted` line for the cluster-identity author. |
| SC-002 | Zero-trusted state is never silent | 0 occurrences of "No unresolved threads found" log while GitHub reports `unresolvedThreads > 0` | Regression test: unresolved thread with only-untrusted authors → assert label retained, `warn` line emitted with author names, no false-positive log. |
| SC-003 | Dedupe never wedges the loop | 0 residual `phase-tracker:*:address-pr-feedback` keys remain marked after any terminal handler exit path in the test suite | Unit test all three exit paths (success, zero-trusted retention, exception) and assert Redis `DEL` invoked; integration test asserts a second unrelated trusted comment on the same PR triggers a fresh claim. |
| SC-004 | One notice per zero-trusted episode | ≤ 1 top-level bot comment carrying the FR-004 marker per PR per zero-trusted state transition | Integration test with 3 consecutive monitor polls against a zero-trusted PR → assert exactly one comment with the marker exists. |
| SC-005 | Monitor and handler agree on trust | The `isTrustedCommentAuthor` predicate has exactly one production call site per package (monitor + handler share the same import) | Grep audit in test: no ad-hoc `authorAssociation` conditions outside the shared function. |

## Assumptions

- The cluster identity is resolvable in the vast majority of live runs (the #830 chain has three fallbacks including a live API probe). FR-007 governs the degraded path; the design does not depend on identity resolution succeeding.
- The monitor's existing previous-state tracking (used for label-transition detection) can carry one more bit — "was zero-trusted last poll" — to gate FR-004's transition-edge posting. If it cannot, the marker-grep already provides idempotency and the transition edge collapses to per-poll no-op.
- #862's dedupe redesign is in flight but not landed. FR-006's "clear on all exit paths" is stated in terms of the current Redis-key semantics; when #862 lands, the invariant translates directly to whatever the new mechanism calls "settled."

## Out of Scope

- The #862 dedupe key redesign itself (this spec is compatible with the current key layout and with #862's redesign; it does not change the layout).
- Trust rules for *pushed commits* on the PR branch (only review-comment authorship is in scope; branch-push author policy is a separate concern).
- The cockpit's own review-composition surface (the fact that the cockpit posts as the cluster identity is a given; this spec does not change how the cockpit submits reviews).
- Auto-resolving GitHub review threads from the bot (Q5-C was explicitly rejected — the operator's unresolved-conversations signal must be preserved).
- Multi-cluster / shared-identity clusters where more than one cluster shares one GitHub identity (single-identity assumption; multi-cluster is a follow-up).

---

*Generated by speckit*
