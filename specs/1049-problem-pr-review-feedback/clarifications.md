# Clarifications for #1049

## Batch 1 — 2026-07-26

### Q1: Fix approach
**Context**: The issue body's *Proposed fix* section lists three distinct options. FR-001 declares the exact evidence-set an implementation choice, but the choice is load-bearing: Option 1 (sticky `agent:*` while a PR is open) forces a `cockpit_advance` behaviour change (Out of Scope carve-out); Options 2 and 3 do not. Deferring to the implementer means the `cockpit_advance` scope is undecided at plan time.
**Question**: Which fix approach should the implementer take?
**Options**:
- A: Keep the last `agent:*` label sticky while an unmerged PR is open on the issue (issue Option 1) — implies a `cockpit_advance` change so it stops stripping `agent:paused`
- B: Widen the orchestrated test to accept `workflow:*` and/or `completed:*` (issue Option 2) — no `cockpit_advance` change needed
- C: Accept ANY speckit label (`agent:*`, `phase:*`, `completed:*`, `workflow:*`) (issue Option 3) — no `cockpit_advance` change needed
- D: Implementer picks freely within FR-001 / FR-002 bounds, including a hybrid

**Answer**: B — Widen the orchestrated test to accept `workflow:*` and/or `completed:*`. No `cockpit_advance` change.

Rationale: Option A needs something to CLEAR the sticky `agent:*` when the PR merges or closes, and no such hook exists anywhere — the issue webhook handles only `action === 'labeled'` (`packages/orchestrator/src/routes/webhooks.ts:71-73`), there is no `pull_request.closed`/`merged` consumer, and `cockpit merge` mutates zero issue labels. So A ships a new invariant with no maintainer and issues stay 'orchestrated' forever.

A's scope estimate in the issue is also wrong, and I want to correct it explicitly: `cockpit advance` only ADDS `completed:<gate>` and removes nothing (`packages/generacy/src/cli/commands/cockpit/advance.ts:168`). The actual stripper of `agent:paused` is `LabelManager.onResumeStart` (`packages/orchestrator/src/worker/label-manager.ts:345-347`), which EVERY gate resume shares — so the carve-out is far larger than 'a `cockpit_advance` change'.

B reads state the engine already maintains: nothing in either repo ever removes a `workflow:*` label, and the single path that clears `completed:*` (requeue) re-adds `workflow:*` in the same call (`packages/orchestrator/src/services/label-monitor-service.ts:397-403`). No new invariant, and the diff is one predicate.

### Q2: Merged PRs
**Context**: The spec is silent on reviews posted after a PR is merged. Reviewers routinely leave inline comments post-merge to file follow-up work. The current `agent:*`-only guard already accepts them (as long as the label is present); a widened guard would too. But the operator may want an explicit gate here.
**Question**: When a reviewer posts a review on a **merged** PR whose linked issue carries widened evidence, should the fixer still enqueue?
**Options**:
- A: Yes — treat merged the same as open for the widened guard (existing behaviour, extended by the widening)
- B: No — skip merged PRs with a new gate (log at `info` per FR-004)
- C: Out of scope — leave whatever happens today as-is; do not add a merged-PR gate in this spec

**Answer**: B — No. Skip merged PRs behind an explicit gate, logged at `info` per FR-004.

This is defect avoidance, not preference. Neither the monitor nor the handler ever reads PR merged/closed state; `cockpit merge` deletes the head ref after squashing (`packages/generacy/src/cli/commands/cockpit/merge.ts:306`, `classifyAndDeleteBranch`); and the handler unconditionally checks out `pr.head.ref` (`pr-feedback-handler.ts:127-138`) and pushes to it (`:670`).

On a cold checkout that hard-fails at `switchBranch`. On the reused bootstrapped checkout — the normal case — `git fetch origin` runs WITHOUT `--prune` (`repo-checkout.ts:110`), so the stale `origin/<branch>` ref survives, the fixer resets to the pre-merge tip, and its push RECREATES the deleted remote branch with commits that can never land. Orphan work plus a resurrected branch.

Option C is the trap: the merged case is masked today ONLY because the `agent:*` guard already fails post-merge. Q1's widening is precisely what makes it reachable — in this same PR. 'Leave whatever happens today as-is' is not a no-op here.

(Note merged PRs reach the monitor only via webhook; the poll lists open PRs only — `pr-feedback-monitor-service.ts:546,570` vs `routes/pr-webhooks.ts:74-92`.)

### Q3: Wrong-cluster gate log level in shared repos
**Context**: FR-004 lifts all four post-`Processing PR review event from poll` gates to `info` when the PR has an unresolved review thread. In a multi-cluster shared repo (e.g., generacy + generacy-cloud + agency all pointing at one org), the "wrong-cluster assignee" gate fires on **every poll** for every PR belonging to another cluster — that is expected, not a bug. Lifting it to `info` will produce a steady stream of expected-noise `info` lines.
**Question**: Should the wrong-cluster gate stay at `debug` (expected noise), or lift to `info` as FR-004 currently states?
**Options**:
- A: Lift all four gates including wrong-cluster — as FR-004 states literally
- B: Keep wrong-cluster at `debug`; lift only the other three (no-link / assignees-empty / not-orchestrated) — revise FR-004
- C: Lift wrong-cluster to `info` only when NO cluster in the repo owns the PR (no assignee matches any known `CLUSTER_GITHUB_USERNAME`) — hybrid

**Answer**: B — Keep the wrong-cluster gate at `debug`; lift only no-link / assignees-empty / not-orchestrated. Revise FR-004 accordingly.

Rationale: the wrong-cluster gate is the only one of the four whose rejection is EXPECTED STEADY STATE rather than a dropped signal. With the 8 repos in this cluster's `MONITORED_REPOS` and the 60s PR-monitor poll (`config/schema.ts:139`), it would emit roughly 60 info lines/hour — ~1440/day — per foreign PR, indefinitely. Q1's widening increases how many PRs reach that gate.

Worse, there is an ordering problem: the gate runs at step 2 (`pr-feedback-monitor-service.ts:169-174`), BEFORE the GraphQL `getPRReviewThreads` call at step 3 (`:201`). So conditioning its level on 'has an unresolved review thread' inverts the order and would force a GraphQL thread fetch for every other cluster's PR on every cycle — charged to the same shared 5k/hr GraphQL budget this account already exhausts.

Option C is unimplementable as written: the orchestrator config carries exactly one `clusterGithubUsername` — its own (`config/schema.ts:127`) — so 'no known cluster owns the PR' would require a new cross-cluster roster, i.e. another unmaintained invariant.

### Q4: `phase:*` alone as orchestration evidence
**Context**: US2's negative acceptance criterion says the guard rejects when NONE of `agent:*` / `phase:*` / `completed:*` / `workflow:*` is present. It does NOT say the guard must ACCEPT when ANY is present — leaving the positive condition ambiguous. An issue with only `phase:specify` (partially-run, workflow assigned but engine dropped it before writing `workflow:*`) is the ambiguous case.
**Question**: Does the presence of ONLY `phase:*` labels (no `completed:*`, `workflow:*`, or `agent:*`) count as sufficient orchestration evidence for the widened guard?
**Options**:
- A: Yes — any of the four label prefixes counts (symmetric with US2's negative)
- B: No — require `workflow:*` or `completed:*` (rejects incomplete/failed runs that never got past specify)
- C: Only `workflow:*` counts as durable evidence (strictest — survives advance, survives completion, survives failure)

**Answer**: B — No. Require `workflow:*` or `completed:*`; `phase:*` alone is not sufficient evidence.

The question's premise is counterfactual: `workflow:<name>` and `agent:in-progress` are added in the SAME `addLabels` call at dispatch, before any phase runs (`label-monitor-service.ts:399-403`). An issue therefore cannot reach `phase:specify` without already carrying `workflow:*` — option A's motivating case (workflow assigned but engine dropped it before writing `workflow:*`) does not exist in this engine.

`phase:*` is also the least durable of the four prefixes — actively removed at phase start, at phase complete, and wholesale by `ensureCleanup` (`label-manager.ts:171-177`, `:205`, `:395-403`) — so accepting it buys no coverage while widening the guard to the one prefix a human might plausibly hand-apply.

Option C is too strict in the other direction: `resolveWorkflowFromLabels` explicitly documents pre-existing issues that legitimately lack `workflow:*` (`label-monitor-service.ts:259-270`), and those still carry `completed:*`. The union {`workflow:*`, `completed:*`} is never empty on an orchestrated issue, because the only path that clears `completed:*` re-adds `workflow:*` in the same call — which makes B both durable and complete.
