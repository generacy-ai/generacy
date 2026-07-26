# Feature Specification: PR review feedback must continue processing after a workflow completes

**Branch**: `1049-problem-pr-review-feedback` | **Date**: 2026-07-26 | **Status**: Draft | **Issue**: [#1049](https://github.com/generacy-ai/generacy/issues/1049)

## Summary

The PR-feedback fixer stops working at the exact moment a human would review the PR. `PrLinker.linkPrToIssue` (step 3) requires the linked issue to carry an `agent:*` label as its evidence-of-orchestration test. The engine strips the last `agent:*` label when a workflow reaches `completed:validate` — the phase that produces the review-ready PR. So a **completed** speckit issue is indistinguishable from a **never-orchestrated** issue under the guard, and every review posted after that point is dropped by the monitor with only a `debug`-level log. The fix must (a) restore review-feedback processing on completed workflows without opening the guard to genuinely non-orchestrated PRs, (b) survive `cockpit_advance` on the implementation-review gate (so the fix does not silently regress cycle-to-cycle), and (c) make the drop observable when it happens.

## Problem

`packages/orchestrator/src/worker/pr-linker.ts` — `linkPrToIssue`, step 3:

```ts
const issue = await github.getIssue(owner, repo, issueNumber);
const isOrchestrated = issue.labels.some((l) => l.name.startsWith('agent:'));

if (!isOrchestrated) {
  this.logger.debug(
    { prNumber: pr.number, issueNumber, owner, repo },
    'Linked issue does not have an agent:* label — skipping non-orchestrated issue',
  );
  return null;
}
```

`PrFeedbackMonitorService.processPrReviewEvent` calls this first and bails on `null`. Because completion strips the last `agent:*` label, the `isOrchestrated` test returns `false` on every issue that has finished its workflow, and every review posted on that issue's PR is silently discarded.

Independently: three of the four gates that can drop a PR-review event log at `debug` (no link, no assignees at `warn` only, wrong cluster, not orchestrated). At the default `info` level the operator sees `Processing PR review event from poll` followed by silence with no way to tell *which* gate dropped it.

Secondary: `agent:paused` — the natural manual workaround — is stripped by `cockpit_advance` on the implementation-review gate. The operator has to re-apply it before every review round, and any fix built on `agent:paused` being sticky needs the label to survive advance too.

## Evidence

A/B verified on 2026-07-26 (issue body reproduces the full log excerpt):

- **Before**: three PRs (`generacy#1048`, `generacy-cloud#881`, `generacy-cloud#882`) at `completed:validate` accumulated 19 unresolved trusted review threads over 14 minutes. Monitor logged `Processing PR review event from poll` on every poll; **no** `Found N unresolved review thread(s)`, no `waiting-for:address-pr-feedback`, no enqueue.
- **Control** in the same log window: PR #1042, whose issue #1038 still carried `agent:paused`, logged `Linked PR #1042 to issue #1038 via pr-body` on every poll.
- **After**: added `agent:paused` to all three at 03:06:43Z. Next poll (03:08:29Z) all three flipped to `waiting-for:address-pr-feedback` and the fixer ran.
- Ruled out (all verified): PR→issue link (`Closes #NNNN` present), assignees (`christrudelpw` = `CLUSTER_GITHUB_USERNAME`), thread trust (all `viewerDidAuthor=true`, `authorAssociation=MEMBER`), no `blocked:*` labels. **The `agent:*` label was the only variable.**

## User Stories

### US1: Post-validate reviews still reach the fixer

**As** an operator reviewing a `/cockpit:auto` PR after its workflow reaches `completed:validate`,
**I want** my review comments to trigger the fixer,
**So that** I don't have to hand-apply `agent:paused` before every review round, and reviews aren't silently lost when I forget.

**Acceptance Criteria**:
- [ ] A review posted on a PR whose linked issue is at `completed:validate` (no `agent:*` label) results in `waiting-for:address-pr-feedback` being applied and a fixer cycle running.
- [ ] The behaviour holds regardless of which workflow ran (`workflow:speckit-feature`, `workflow:speckit-bugfix`, or others that reach `completed:validate`).
- [ ] Re-review after `cockpit_advance` on the implementation-review gate continues to enqueue — the fix does not depend on any label that `cockpit_advance` strips.

### US2: Non-orchestrated PRs are still ignored

**As** the PR-feedback monitor,
**I want** to keep declining to process human-authored PRs on issues that never entered the speckit pipeline,
**So that** the widened guard doesn't cause the monitor to reply to unrelated PRs in a monitored repo.

**Acceptance Criteria**:
- [ ] A review on a PR whose linked issue has no speckit labels of any kind (no `agent:*`, no `phase:*`, no `completed:*`, no `workflow:*`) does not enqueue — the guard still rejects.
- [ ] A PR whose body does not link to an issue at all (no `Closes #NNNN`) is still rejected at the link stage — this fix does not alter link resolution.

### US3: Silent drops become visible

**As** an operator diagnosing "the fixer stopped working",
**I want** the log to name the gate that rejected the review-carrying event,
**So that** I can tell "no link" from "not orchestrated" from "not assigned" without reading the source.

**Acceptance Criteria**:
- [ ] When any of the four post-`Processing PR review event from poll` gates (no link, no assignees, wrong-cluster assignee, not orchestrated) drops an event on a PR that has at least one unresolved review thread, the drop is logged at `info` or higher (not `debug`).
- [ ] The log line names which specific gate rejected the event (link / assignees / cluster / orchestration).
- [ ] Events on PRs with zero unresolved review threads may still log at `debug` — the `info` bar is scoped to "PR has pending human feedback that the monitor is declining to process".

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestration-guard in `PrLinker.linkPrToIssue` must accept as "orchestrated" any issue that carries evidence of having gone through the speckit pipeline, not only issues that currently carry an `agent:*` label. The evidence-set is a design choice bounded by FR-002 (guard must still reject genuinely non-orchestrated issues). Acceptable evidence includes, but is not limited to: any `agent:*` label, any `workflow:*` label, any `completed:*` label, or the presence of an open PR on the issue. | P1 | Which exact evidence to accept is an implementation choice — the guard must not depend on `agent:*` alone, and must not reject issues purely because their workflow finished. |
| FR-002 | The guard must still reject issues that have no speckit-lifecycle evidence — i.e. reviews on PRs whose linked issue was never orchestrated must not enqueue. | P1 | US2. Prevents the widening from acting on human-authored PRs in a monitored repo. |
| FR-003 | Whatever marker or label the fix keys off must survive `cockpit_advance` on the implementation-review gate. If the fix relies on any label that is currently stripped by `cockpit_advance`, either the stripping behaviour must change or a different marker must be chosen. | P1 | Secondary bug in the issue. Otherwise the fix regresses on every subsequent advance. |
| FR-004 | When the "not orchestrated" or "no link" gates drop a PR-review event on a PR that has at least one unresolved review thread, the log line must be emitted at `info` or higher. | P1 | US3. Scoped so quiet PRs don't spam logs. |
| FR-005 | The `info`-or-higher log line for a dropped review event must name which gate rejected it (link / assignees-empty / assignees-wrong-cluster / not-orchestrated). | P2 | Not strictly required to distinguish; nice-to-have for diagnosis. Same call site emits one message per gate today, so the discriminator is free. |
| FR-006 | The fix must apply uniformly to all workflows that reach a completed terminal phase — not only `speckit-bugfix` (which was the reproducer) or `speckit-feature`. | P1 | The guard is workflow-agnostic today; the fix must remain so. |
| FR-007 | Zero change to the `parsePrBody` / `Closes #NNNN` link-resolution path, the assignee-cluster check, the thread-trust check, or the `blocked:*` skip gate. | P2 | These were all verified as not contributing to the observed bug; keep them untouched to bound blast radius. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Reviews on PRs with completed workflows that fail to enqueue | 0 | Regression test: issue at `completed:validate` (no `agent:*`) + PR with an unresolved trusted thread → `enqueue` called on the next monitor poll. |
| SC-002 | False positives from the widened guard | 0 | Test: issue with **no** speckit labels of any kind + PR referencing it → guard rejects, `enqueue` not called. |
| SC-003 | Regression of the fix across `cockpit_advance` cycles | 0 | Test: reproduce the fix-active state, run `cockpit_advance` on the implementation-review gate, post a new review, assert next poll still enqueues. |
| SC-004 | Drops on PRs-with-pending-feedback logged below `info` | 0 | Test: exercise each of the four drop gates against a PR that has an unresolved review thread; assert every drop is logged at `info` or higher and names the responsible gate. |
| SC-005 | Manual `agent:paused` re-applications required per `/cockpit:auto` review round on a completed workflow | 0 | Observational: follow the next N `/cockpit:auto` runs post-merge for hand-applied `agent:paused` labels attributable to this bug. |

## Assumptions

- The four "drop" gates in `PrFeedbackMonitorService.processPrReviewEvent` (link null, empty assignees, wrong-cluster assignees, not-orchestrated) are the exhaustive rejection surface between `Processing PR review event from poll` and enqueue — verified by reading the source in the issue evidence. If a fifth gate is discovered during implementation, FR-004 extends to cover it.
- `github.getIssue` returns the full label set on the issue at the time of the call — no staleness concerns from cached label state.
- `cockpit_advance` on the implementation-review gate strips `agent:paused`; this was observed on every advance in the reproducer session. Whether it also strips `workflow:*` or `completed:*` is answered by the current codebase; any evidence-token the fix keys off must be verified to survive advance.
- "Unresolved review thread" for FR-004 means the same thread-set the monitor already computes via `getPRReviewThreads` + trust filter — no new fetch is required to gate the log-level decision.
- The fix does not need to distinguish `speckit-feature` from `speckit-bugfix` — the bug and the fix are workflow-agnostic.
- The `blocked:*` skip gate (`pr-feedback-monitor-service.ts:328-341`) fires *before* `PrLinker`, so a PR whose issue carries `blocked:*` is already skipped for reasons unrelated to this bug and is out of scope for FR-004's log-level lift.

## Out of Scope

- Changing the PR→issue link-resolution logic in `parsePrBody` or the `Closes #NNNN` grammar. The link resolves correctly in the reproducer; this fix does not alter link resolution.
- Changing the assignee-cluster check (`CLUSTER_GITHUB_USERNAME`). Assignees resolved correctly in the reproducer.
- Changing the thread-trust logic (`isTrustedCommentAuthor`). All 19 threads were trusted; the drop happened upstream.
- Changing the `blocked:*` skip gate. No `blocked:*` labels were involved in the reproducer.
- Refactoring the four-gate rejection chain into a single decision function. The log-level lift can be done in place at each gate.
- Consuming review bodies (not just inline threads) — that is issue #1047, tracked separately. The fix here restores the enqueue path; the input the fixer consumes on that path is #1047's concern.
- Any change to `cockpit_advance`'s label-stripping behaviour beyond what FR-003 requires. If the fix chooses an evidence-token `cockpit_advance` already preserves (e.g., `workflow:*` or `completed:*`), no change to advance is needed and none is in scope. If the fix relies on `agent:paused` being sticky across advance, the required advance-side change is in scope for THIS spec's implementation.
- Retroactive processing of reviews posted before the fix ships — the monitor's next poll after the fix will pick up whatever is unresolved at that time.

---

*Generated by speckit*
