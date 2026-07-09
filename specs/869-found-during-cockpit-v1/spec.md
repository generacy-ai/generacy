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

### US1: Cockpit request-changes drives the loop (Primary)

**As an** operator using the cockpit implementation-review gate,
**I want** the request-changes review I submit through the cockpit to be auto-addressed by the agent,
**So that** the human-approved feedback the pipeline was designed to consume actually reaches the worker, without me having to open a second personal account to reply from.

**Acceptance Criteria**:
- [ ] A review comment authored by the resolved cluster identity (bot/App login) with `author_association: NONE` on an unresolved thread is treated as trusted for the `pr-feedback` surface.
- [ ] The live repro (christrudelpw/sniplink#4 / PR #14) — where the cockpit posted a request-changes review from the App identity — is processed end-to-end (worker addresses the comment, pushes changes, replies to the thread).
- [ ] The trust decision is emitted in structured logs so the "why did/didn't this fire" question is answerable from log lines alone.

### US2: Zero-trusted state is loud, not silent

**As an** operator watching the pipeline,
**I want** the handler to loudly retain state and surface a diagnostic when unresolved threads exist but none are from trusted authors,
**So that** the same class of fail-silent bug that #861 fixed (label removed, worker "succeeds") does not recur one layer up in the trust filter.

**Acceptance Criteria**:
- [ ] When `unresolvedThreads > 0` and `trustedUnresolvedComments == 0`, the handler does NOT remove `waiting-for:address-pr-feedback`.
- [ ] The handler does NOT emit the log line "No unresolved threads found" in this case (it is factually wrong: its own structured fields say otherwise).
- [ ] The handler emits a `warn`-level log naming the skipped authors and their `reason` codes.
- [ ] The handler optionally posts a bot-visible notice on the PR of the shape "feedback is present but not from a trusted author — reply from a maintainer account to proceed" (matching the #842 clarification-poster pattern).

### US3: Monitor and handler agree on eligibility

**As an** orchestrator maintainer,
**I want** the monitor (which decides to enqueue) and the handler (which decides to act) to evaluate the same thread set through the same trust predicate,
**So that** the monitor can never manufacture work the handler will silently discard — a class of busy-loop that is only masked today by the wedge dedupe key.

**Acceptance Criteria**:
- [ ] The trust predicate is a single shared function (or the asymmetry is explicitly documented, bounded, and justified in-code).
- [ ] If the monitor path is refactored to filter by trust, the "enqueue → immediate zero-trusted exit" pattern is no longer possible.
- [ ] If the asymmetry is retained (e.g., monitor over-enqueues intentionally), the handler's zero-trusted exit path must be non-destructive per US2.

### US4: Dedupe never strands a live thread

**As an** operator,
**I want** the enqueue-dedupe key to be settled on every handler exit path,
**So that** a later new trusted comment on the same PR re-triggers the loop instead of being permanently skipped until TTL expiry.

**Acceptance Criteria**:
- [ ] The handler clears (or the framework settles) the `phase-tracker:<owner>:<repo>:<pr>:address-pr-feedback` key on every terminal exit path (success, zero-trusted, error).
- [ ] A subsequent monitor poll that observes a new trusted comment re-enqueues the item rather than logging "Duplicate detected … Skipping duplicate".
- [ ] This behavior is preserved (or explicitly subsumed) by #862's dedupe redesign — the two changes compose correctly.

## Functional Requirements

| ID     | Requirement | Priority | Notes |
|--------|-------------|----------|-------|
| FR-001 | The `pr-feedback` trust decision MUST return `trusted: true` when the comment author matches the resolved cluster identity (bot login), regardless of `author_association` value. | P0 | Bot-login check already exists in `isTrustedCommentAuthor`; must verify handler passes the correctly-resolved `botLogin` on the actual live path. Chain: config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`. |
| FR-002 | When unresolved threads exist but zero comments pass the trust filter, the handler MUST NOT remove the `waiting-for:address-pr-feedback` label. | P0 | Directly replaces the current `unresolvedComments.length === 0` short-circuit at `pr-feedback-handler.ts:196-203`. |
| FR-003 | When unresolved threads exist but zero comments pass the trust filter, the handler MUST NOT log "No unresolved threads found" and MUST emit a `warn` naming the skipped authors and their trust `reason` codes. | P0 | Same code site as FR-002. |
| FR-004 | On the zero-trusted exit path, the handler SHOULD post a single bot-visible notice to the PR indicating trusted-author feedback is required to proceed. | P1 | Follow #842 clarification-poster pattern; must be idempotent (one notice per zero-trusted state, not per poll). |
| FR-005 | The monitor and handler MUST evaluate PR thread eligibility through the same trust predicate, OR the asymmetry MUST be explicitly documented and justified in-code AND the handler's zero-trusted path MUST be non-destructive (per FR-002/FR-003). | P0 | Prefers shared predicate; falls back to documented asymmetry only if refactor scope is prohibitive. |
| FR-006 | The handler MUST settle the enqueue-dedupe key (`phase-tracker:<owner>:<repo>:<pr>:address-pr-feedback`) on every terminal exit path (success, zero-trusted retention, exception). | P0 | Interacts with #862; if #862 lands first, FR-006 is satisfied by inheritance and must be verified, not re-implemented. |
| FR-007 | The trust decision for every ingested comment MUST be logged at `info` level with structured fields (`commentId`, `author`, `authorAssociation`, `reason`, `trusted`), so the trust outcome for each poll is auditable from log lines alone. | P1 | Existing skip-log covers untrusted; add symmetric log for trusted-accept path so both branches are visible. |
| FR-008 | Regression coverage: the four scenarios enumerated in the issue's "Regression tests" section MUST have unit or integration tests in the orchestrator/workflow-engine packages. | P0 | Bot-authored NONE → processed; all-untrusted → label retained + warn + no false log; monitor/handler predicate agreement; dedupe cleared on every exit. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | Bot-authored request-changes comments processed | 100% | Re-run the PR #14 flow (or an equivalent fixture); the review comment authored by the cluster App identity is not skipped by the trust filter. |
| SC-002 | Zero-trusted exit paths retain state | 100% | For every handler exit where `unresolvedThreads > 0 && trustedUnresolvedComments == 0`, the `waiting-for:address-pr-feedback` label is present at exit AND the dedupe key is cleared. Verified in unit + one live rerun. |
| SC-003 | Wedge does not recur | 0 occurrences | On a fresh repro of PR #14, no subsequent monitor poll logs `Duplicate detected (atomic check) … Skipping duplicate` for an unresolved-thread state. |
| SC-004 | Monitor / handler predicate agreement | 100% (or explicitly bounded) | Either a shared function is imported by both call sites (grep), or the asymmetry is documented in-code with a comment referencing this spec and #862. |
| SC-005 | Fail-silent regression audit | Zero "No unresolved threads found" log lines when `unresolvedThreads > 0` | grep production logs (post-fix) for the exact string, cross-referenced with the same-line `unresolvedThreads` field. |
| SC-006 | Live cockpit request-changes → worker action | End-to-end pass | Rerun the cockpit v1 integration smoke test (`tetrad-development#88`) request-changes gate; worker addresses the comment, pushes a commit, replies to the thread, removes the label. |

## Assumptions

- The `#830` cluster-identity resolution chain (config → `CLUSTER_GITHUB_USERNAME` → `GH_USERNAME` → `gh api user`) is reliable and present at handler runtime. If it is not, FR-001 degrades to "handler with unresolvable identity falls through to the existing `author_association` gate" — this is a defensible degradation but should be logged.
- `#862`'s dedupe redesign will land independently. This spec's FR-006 is compatible with #862's approach and is stated so that either ordering (this-first or #862-first) yields a correct end state.
- Monitor and handler live in the same package (or share `workflow-engine/security`) such that a shared trust predicate is a realistic refactor. If they don't, the asymmetry-documentation escape hatch in FR-005 applies.
- Reply-from-personal-account is not a viable long-term workaround (confirmed by the live incident) — the fix must land in the pipeline, not in operator behavior.

## Out of Scope

- Redesigning the dedupe key layout or TTL semantics — that is `#862`'s remit; this spec only requires that whatever the dedupe framework is, the handler settles it on every exit.
- Widening trust to bot accounts beyond the cluster's own resolved identity (no "trust any GitHub App" policy).
- Cockpit-side UX changes (e.g., prompting the operator to also reply from a personal account) — the fix is in the orchestrator/handler.
- Refactoring the `authorAssociation` tier taxonomy itself; this spec composes with the existing `TIER_TO_TRUSTED_REASON` / `KNOWN_UNTRUSTED_TIERS` matrices in `packages/workflow-engine/src/security/comment-trust.ts`.
- Repairing the specific live repro state left in place at PR #14 — that PR is being kept as evidence per the issue's "Repro state left in place" note.

## Related Issues

- **#842** — Author-trust filter (composes with this fix; the trust matrix is inherited from here).
- **#861** — Original PR-feedback loop fix (this bug is a fail-silent regression one layer up).
- **#830** — Cluster identity resolution chain (FR-001's `botLogin` source).
- **#862** — Dedupe redesign (FR-006's interacting change).
- **#849** — Prior history-keyed-dedupe stranding class (context for FR-006).
- **generacy-ai/tetrad-development#88** — Cockpit v1 integration smoke test; this is finding #31.

---

*Generated by speckit*
