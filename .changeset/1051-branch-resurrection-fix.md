---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Prevent orchestrator worker from resurrecting merged-and-deleted branches (#1051).

Bundles three independent, additive fixes that together prevent a re-entering
worker from resurrecting a deleted branch and opening a duplicate PR that claims
`Closes #<already-closed>`:

- **FR-001**: adds `--prune` to the multi-ref `git fetch origin` in both
  `RepoCheckout.switchBranch` and `RepoCheckout.updateRepo`. Deleted upstream
  branches are removed from local tracking refs so `reset --hard origin/<branch>`
  no longer silently succeeds against a stale ref. `fetchBase` (single-ref) is
  unchanged.
- **FR-002/003**: new stateless `push-guard` module + wiring at three sites
  (`pr-feedback-handler.commitAndPushChanges`, `pr-manager.commitAndPush`,
  `phase-loop` entry). Refuses a push when the PR has already merged/closed,
  the remote branch is missing under an open PR, or the PR-state lookup itself
  fails; emits `event: 'push-refused'` with a `reason` enum
  (`pr-merged`/`pr-closed`/`branch-missing`/`pr-lookup-failed`) and clears
  `agent:in-progress` (plus adds `agent:error` on still-open issues). Never
  adds `failed:<phase>` — that would invite `/cockpit:resume` into a loop. The
  refusal signal propagates from `PrManager.commitPushAndEnsurePr` (via a new
  `CommitResult.pushRefused` field) up to `phase-loop`, which aborts the
  workflow — otherwise `ensureDraftPr` would open a duplicate PR against the
  merged branch and the loop would flip the PR ready-for-review with zero
  commits pushed.
- **FR-005**: `LabelMonitorService.processLabelEvent` drops both `process`
  and `resume` events whose target issue is closed at enqueue time, emitting
  one `info` log line with `dropped: 'issue-closed'`. Zero mutations on drop.
  Complements #1049's `PrFeedbackMonitorService` merged-PR gate, which covers
  only the address-pr-feedback entry path. Scope: gate fires inside
  `processLabelEvent` only — four other enqueue paths (base-advance-monitor,
  worker-dispatcher lease-expiry / post-complete rearm, pr-feedback-monitor)
  are out of scope for this spec and tracked as follow-ups.
- **FR-004** (RETRACTED): the original writeup claimed cross-issue working-tree
  contamination from `d8e392ca`. That commit is actually a two-parent merge
  commit; the `added` file statuses were an API artifact of GitHub diffing
  merges against parent 1 only. No contamination mechanism was ever present in
  the observed evidence. Corresponding regression test deleted.

`workflow-engine` gains one new internal method `findPRForBranchAnyState` on
`GitHubClient` — used only by orchestrator's `push-guard`, not re-exported at
the public boundary. **Throws** on non-zero `gh` exit (silent null-on-error is
the wrong contract for a safety-gate input); returns `null` only for the
operationally-meaningful "no PR exists" case. Uses `--limit 10` plus a
caller-side merged-precedence scan so a MERGED PR older than a CLOSED PR on
the same branch still produces the more diagnostic `reason: 'pr-merged'`.
Existing `findPRForBranch` is intentionally unchanged; five call sites depend
on its open-only default.

No new labels, no new persisted state, no workflow-YAML changes.
