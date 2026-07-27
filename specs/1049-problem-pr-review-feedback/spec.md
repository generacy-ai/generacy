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
- [ ] A review on a PR whose linked issue carries none of `agent:*`, `workflow:*`, or `completed:*` does not enqueue — the guard still rejects.
- [ ] A review on a PR whose linked issue carries ONLY `phase:*` (no `agent:*`, no `workflow:*`, no `completed:*`) does not enqueue — `phase:*` alone is not sufficient evidence (per clarification Q4=B).
- [ ] A PR whose body does not link to an issue at all (no `Closes #NNNN`) is still rejected at the link stage — this fix does not alter link resolution.

### US3: Silent drops become visible

**As** an operator diagnosing "the fixer stopped working",
**I want** the log to name the gate that rejected the review-carrying event,
**So that** I can tell "no link" from "not orchestrated" from "not assigned" without reading the source.

**Acceptance Criteria**:
- [ ] When any of the three post-`Processing PR review event from poll` gates (no link, no assignees, not orchestrated) drops an event on a PR that has at least one unresolved review thread, the drop is logged at `info` or higher (not `debug`).
- [ ] The log line names which specific gate rejected the event (link / assignees-empty / orchestration).
- [ ] The wrong-cluster-assignee gate remains at `debug` regardless of unresolved-thread state — per clarification Q3=B, its firing is expected steady-state noise in multi-cluster shared repos.
- [ ] Events on PRs with zero unresolved review threads may still log at `debug` — the `info` bar is scoped to "PR has pending human feedback that the monitor is declining to process".

### US4: Reviews on merged PRs must not resurrect deleted branches

**As** the PR-feedback monitor,
**I want** to explicitly refuse to enqueue reviews posted on merged PRs,
**So that** the fixer does not check out a deleted branch, reset to the pre-merge tip, and push orphan commits that recreate the deleted remote branch.

**Acceptance Criteria**:
- [ ] A review posted on a merged PR (arriving via the webhook path — the poll lists open PRs only) does not enqueue, regardless of what evidence the linked issue carries.
- [ ] The refusal is logged at `info` level and names the merged-PR gate as the cause (per FR-004 log-level treatment and FR-005 naming).
- [ ] The gate fires BEFORE any checkout / fetch / push code path can run — it is a pre-enqueue gate, not a handler-side abort.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestration-guard in `PrLinker.linkPrToIssue` must accept as "orchestrated" any issue that carries a `workflow:*` label OR a `completed:*` label. `agent:*` alone remains sufficient for currently-active workflows but is no longer required. `phase:*` alone is NOT sufficient (least-durable prefix — stripped at phase start/complete and by `ensureCleanup`). | P1 | Clarification Q1=B + Q4=B. The union `{workflow:*, completed:*}` is durable: nothing removes `workflow:*`, and the sole path that clears `completed:*` (requeue) re-adds `workflow:*` in the same call (`label-monitor-service.ts:397-403`). |
| FR-002 | The guard must still reject issues that have no speckit-lifecycle evidence — i.e. reviews on PRs whose linked issue carries none of `agent:*`, `workflow:*`, or `completed:*` must not enqueue. | P1 | US2. Prevents the widening from acting on human-authored PRs in a monitored repo. |
| FR-003 | The evidence-set chosen in FR-001 (`workflow:*` / `completed:*`) must survive `cockpit_advance` on the implementation-review gate. No `cockpit_advance` behaviour change is required or in scope: nothing in either repo removes `workflow:*`, and `completed:*` is only cleared alongside a re-add of `workflow:*` on requeue. | P1 | Clarification Q1=B. `cockpit advance` only ADDS `completed:<gate>` (`advance.ts:168`); it does not strip `agent:*`. The actual stripper of `agent:paused` is `LabelManager.onResumeStart` — irrelevant once the guard no longer keys on `agent:*`. |
| FR-004 | When the "no link", "assignees-empty", or "not-orchestrated" gates drop a PR-review event on a PR that has at least one unresolved review thread, the log line must be emitted at `info` or higher. The "wrong-cluster assignee" gate stays at `debug` — its rejection is expected steady-state noise in multi-cluster shared repos and lifting it would emit ~1440 info lines/day per foreign PR. | P1 | Clarification Q3=B. US3. Wrong-cluster is the only gate whose firing is expected on every poll of every foreign-cluster PR, and it runs BEFORE the GraphQL `getPRReviewThreads` call at step 3 — conditioning its level on "has unresolved thread" would force a thread fetch per foreign PR per cycle against the same 5k/hr GraphQL budget. |
| FR-005 | The `info`-or-higher log line for a dropped review event must name which gate rejected it (link / assignees-empty / not-orchestrated). | P2 | Not strictly required to distinguish; nice-to-have for diagnosis. Wrong-cluster excluded per FR-004 revision. |
| FR-006 | The fix must apply uniformly to all workflows that reach a completed terminal phase — not only `speckit-bugfix` (which was the reproducer) or `speckit-feature`. | P1 | The guard is workflow-agnostic today; the fix must remain so. |
| FR-007 | Zero change to the `parsePrBody` / `Closes #NNNN` link-resolution path, the assignee-cluster check, the thread-trust check, or the `blocked:*` skip gate. | P2 | These were all verified as not contributing to the observed bug; keep them untouched to bound blast radius. |
| FR-008 | Reviews posted on a **merged** PR must NOT enqueue, regardless of the linked issue's orchestration evidence. When a merged PR would otherwise pass the FR-001 guard, a new merged-PR gate must reject it and emit an `info`-level log line (per FR-004's log-level treatment). | P1 | Clarification Q2=B. Defect avoidance: `cockpit merge` deletes the head ref post-squash (`merge.ts:306`); the handler unconditionally checks out `pr.head.ref` and pushes to it — on the reused bootstrapped checkout `git fetch origin` runs without `--prune` (`repo-checkout.ts:110`), so the stale `origin/<branch>` survives, the fixer resets to the pre-merge tip, and its push RECREATES the deleted remote branch with orphan commits. The merged case is masked today only because the `agent:*` guard fails post-merge — FR-001's widening makes it reachable in the same PR. Merged PRs reach the monitor only via webhook; the poll lists open PRs only (`pr-feedback-monitor-service.ts:546,570` vs `routes/pr-webhooks.ts:74-92`), so this gate protects the webhook path specifically. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Reviews on PRs with completed workflows that fail to enqueue | 0 | Regression test: issue at `completed:validate` (no `agent:*`) + PR with an unresolved trusted thread → `enqueue` called on the next monitor poll. |
| SC-002 | False positives from the widened guard | 0 | Test: (a) issue with no speckit labels at all + PR referencing it → guard rejects; (b) issue with only `phase:specify` (no `workflow:*` / `completed:*` / `agent:*`) + PR referencing it → guard rejects. Both must NOT call `enqueue`. |
| SC-003 | Regression of the fix across `cockpit_advance` cycles | 0 | Test: reproduce the fix-active state, run `cockpit_advance` on the implementation-review gate, post a new review, assert next poll still enqueues (evidence-set is `workflow:*` / `completed:*`, neither of which `cockpit_advance` touches). |
| SC-004 | Drops on PRs-with-pending-feedback logged below `info` (excluding wrong-cluster) | 0 | Test: exercise each of the three qualifying drop gates (no link / assignees-empty / not-orchestrated) against a PR that has an unresolved review thread; assert every drop is logged at `info` or higher and names the responsible gate. Wrong-cluster gate excluded — assert it remains at `debug` even when the target PR has an unresolved thread. |
| SC-005 | Manual `agent:paused` re-applications required per `/cockpit:auto` review round on a completed workflow | 0 | Observational: follow the next N `/cockpit:auto` runs post-merge for hand-applied `agent:paused` labels attributable to this bug. |
| SC-006 | Orphan commits pushed to deleted branches after webhook-delivered review on a merged PR | 0 | Test: simulate webhook `pull_request_review` event on a merged PR whose head branch has been deleted (post-`cockpit merge`); assert enqueue is not called and no `git push` occurs. Logged at `info` with the merged-PR gate name (per FR-008). |

## Assumptions

- The four "drop" gates in `PrFeedbackMonitorService.processPrReviewEvent` (link null, empty assignees, wrong-cluster assignees, not-orchestrated) are the exhaustive rejection surface between `Processing PR review event from poll` and enqueue — verified by reading the source in the issue evidence. FR-008 adds a fifth (merged-PR) gate scoped to the webhook path. If a sixth gate is discovered during implementation, FR-004's log-level treatment extends to cover it under the same "info if PR has unresolved thread" rule (with wrong-cluster remaining the sole `debug`-level exception per FR-004).
- `github.getIssue` returns the full label set on the issue at the time of the call — no staleness concerns from cached label state.
- `workflow:*` labels are never removed by any code path in either repo (verified against `label-monitor-service.ts` and `label-manager.ts`). `completed:*` labels are only cleared by the requeue path (`label-monitor-service.ts:397-403`), which re-adds `workflow:*` in the same call. The union `{workflow:*, completed:*}` therefore forms a durable orchestration marker that survives `cockpit_advance`, phase transitions, workflow completion, and requeue — no `cockpit_advance` behaviour change is required (per clarification Q1=B).
- `phase:*` labels are actively removed at phase start, at phase complete, and wholesale by `ensureCleanup` (`label-manager.ts:171-177`, `:205`, `:395-403`), making them the least durable of the four prefixes. They are also load-bearing for `LabelMonitorService` bookkeeping — a human plausibly hand-applying `phase:*` would trigger unrelated engine behaviour. `phase:*` is therefore excluded from the guard's positive evidence-set (per clarification Q4=B).
- "Unresolved review thread" for FR-004 means the same thread-set the monitor already computes via `getPRReviewThreads` + trust filter — no new fetch is required to gate the log-level decision. This assumption specifically does NOT apply to the wrong-cluster gate (FR-004 keeps it at `debug` regardless), which runs BEFORE the GraphQL thread fetch and must not force the fetch to gate its own log level (per clarification Q3=B).
- The fix does not need to distinguish `speckit-feature` from `speckit-bugfix` — the bug and the fix are workflow-agnostic.
- The `blocked:*` skip gate (`pr-feedback-monitor-service.ts:328-341`) fires *before* `PrLinker`, so a PR whose issue carries `blocked:*` is already skipped for reasons unrelated to this bug and is out of scope for FR-004's log-level lift.
- The merged-PR defect (FR-008) is reachable only via the webhook path. The poll path (`pr-feedback-monitor-service.ts:546,570`) lists open PRs only; the webhook path (`routes/pr-webhooks.ts:74-92`) forwards every review event regardless of merged state. Today the `agent:*`-only guard masks the defect on the webhook path too; FR-001's widening makes it reachable, which is why FR-008 must land in the same PR — not as follow-up.

## Out of Scope

- Changing the PR→issue link-resolution logic in `parsePrBody` or the `Closes #NNNN` grammar. The link resolves correctly in the reproducer; this fix does not alter link resolution.
- Changing the assignee-cluster check (`CLUSTER_GITHUB_USERNAME`). Assignees resolved correctly in the reproducer.
- Changing the thread-trust logic (`isTrustedCommentAuthor`). All 19 threads were trusted; the drop happened upstream.
- Changing the `blocked:*` skip gate. No `blocked:*` labels were involved in the reproducer.
- Refactoring the four-gate rejection chain into a single decision function. The log-level lift can be done in place at each gate.
- Consuming review bodies (not just inline threads) — that is issue #1047, tracked separately. The fix here restores the enqueue path; the input the fixer consumes on that path is #1047's concern.
- Any change to `cockpit_advance`'s label-stripping behaviour. Per clarification Q1=B, the chosen evidence-set (`workflow:*` / `completed:*`) is preserved by `cockpit_advance` already, so no advance-side change is required or in scope. (For the record: `cockpit advance` at `advance.ts:168` only ADDS `completed:<gate>` and removes nothing — the actual `agent:paused` stripper is `LabelManager.onResumeStart` at `label-manager.ts:345-347`, which is irrelevant now that the guard no longer keys on `agent:*`.)
- Retroactive processing of reviews posted before the fix ships — the monitor's next poll after the fix will pick up whatever is unresolved at that time.

---

*Generated by speckit*
