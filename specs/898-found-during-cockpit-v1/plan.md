# Implementation Plan: `waiting-for:merge-conflicts` engine-side handler + self-describing pause

**Feature**: File the deferred conflict-resolution follow-up from #864 and give the pause a self-describing manual remedy in a single PR.
**Branch**: `898-found-during-cockpit-v1`
**Status**: Complete

## Summary

Two ships in one PR from this branch (Q1 → A):

- **Ship 1 (P0, unblocker + permanent escalation surface)** — the `#864` pre-phase base-merge pause comment MUST render the three-step manual remedy verbatim (list conflicted paths, tell the operator to resolve on the branch and push, then `cockpit advance --gate merge-conflicts`), plus a label-protocol doc update. Same "state carries its own remedy" pattern as `#874` FR-006.
- **Ship 2 (P1, primary)** — the deferred bounded conflict-resolution handler shaped like `PrFeedbackHandler` (`packages/orchestrator/src/worker/pr-feedback-handler.ts:55`). Poll-based label monitor recognizes `waiting-for:merge-conflicts + agent:paused`, enqueues a `resolve-merge-conflicts` queue item via `enqueueIfAbsent` (`#862/#879` in-flight dedupe; **no** `phase-tracker:*:resume:*` key), the worker checks out the branch, merges `origin/<base>`, invokes the agent CLI **exactly once** with a bounded conflict-resolution prompt, pushes on success, or applies `blocked:stuck-merge-conflicts` + evidence on failure.

Ship 1 remains permanently load-bearing after Ship 2 lands: when the handler's one attempt fails and pauses at `blocked:stuck-merge-conflicts`, the operator escalation path is *exactly* the Ship 1 remedy text.

## Technical Context

- **Language**: TypeScript, Node.js `>= 22`, ESM.
- **Primary packages touched**:
  - `packages/orchestrator/` — new `MergeConflictHandler`, new `MergeConflictMonitorService`, `phase-loop.ts` pause-comment mutation, `QueueItem.command` union extension, worker dispatch branch, `server.ts` wiring.
  - `packages/workflow-engine/` — `WORKFLOW_LABELS` gains `blocked:stuck-merge-conflicts`.
  - `packages/generacy-plugin-claude-code/` — new `MergeConflictIntent` in `src/launch/types.ts` (peer of `PrFeedbackIntent`).
- **Deps** (no new packages):
  - `@generacy-ai/workflow-engine` — `GhCliGitHubClient.listOpenPullRequests()` (`gh-cli.ts:680`) is the `#892 Q4` mechanic used for FR-005 same-base-in-repo enumeration.
  - `git` CLI — `git merge`, `git fetch`, `git push` invoked via `execFile` (mirrors `base-merge.ts`).
- **Relevant existing surfaces reused verbatim**:
  - `enqueueIfAbsent(item)` on `QueueManager` (`packages/orchestrator/src/types/monitor.ts:232`) — sole dedupe mechanism.
  - `#864`'s pre-phase base-merge pause site (`phase-loop.ts:911-950`) — Ship 1 mutates the `errorEvidence.mergeConflict` render block; **no** change to when/how the pause fires.
  - `PrFeedbackMonitorService` (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts:50`) as the shape template for the new monitor (poll cycle, `blocked:*` skip, `enqueueIfAbsent` enqueue).
  - `#883` `blocked:stuck-feedback-loop` termination pattern (`pr-feedback-handler.ts:689-707`) — direct precedent for `blocked:stuck-merge-conflicts`.
  - `LabelManager` (`packages/orchestrator/src/worker/label-manager.ts`) — used for the `completed:merge-conflicts` + `waiting-for` removal triple on success.
- **Constitution**: no `.specify/memory/constitution.md` present — no additional gate.

## Ship boundaries

| Ship | Requirements | Priority | Reversibility |
|------|-------------|----------|---------------|
| Ship 1 | FR-011, FR-012, FR-013, FR-014 (docs half), part of FR-015 | P0 | Trivially reversible — pure comment-render + docs. |
| Ship 2 | FR-001–FR-010, FR-014 (handler half), part of FR-015 | P1 | New handler + monitor + queue-item type. Reverting removes the new files; existing code unchanged in shape. |

Both land together in a single PR from this branch. Q5 → D confirms Ship 1's content is all P0 (including the label-protocol doc — `agency#396`'s audit reads that doc).

## Project structure

```
packages/orchestrator/
  src/
    worker/
      phase-loop.ts                          # MODIFIED — Ship 1: expand errorEvidence render at :929-941
      merge-conflict-handler.ts              # NEW — Ship 2: mirrors pr-feedback-handler.ts shape
      merge-conflict-prompt.ts               # NEW — Ship 2: bounded agent prompt builder (mirrors buildFeedbackPrompt)
      __tests__/
        merge-conflict-handler.test.ts       # NEW — Ship 2: unit tests (happy path, one-attempt, sibling guard, retries)
        phase-loop.merge.test.ts             # MODIFIED — Ship 1: assert new stage-comment content
      claude-cli-worker.ts                   # MODIFIED — Ship 2: dispatch branch at :285
    services/
      merge-conflict-monitor-service.ts      # NEW — Ship 2: poll-based enqueue for waiting-for:merge-conflicts
      __tests__/
        merge-conflict-monitor-service.test.ts  # NEW — Ship 2
    types/
      monitor.ts                             # MODIFIED — Ship 2: QueueItem.command += 'resolve-merge-conflicts';
                                             #   add ResolveMergeConflictsMetadata
    server.ts                                # MODIFIED — Ship 2: instantiate + start MergeConflictMonitorService
packages/workflow-engine/
  src/actions/github/
    label-definitions.ts                     # MODIFIED — Ship 2 (labels), Ship 1 (docstring on waiting-for:merge-conflicts)
packages/generacy-plugin-claude-code/
  src/launch/
    types.ts                                 # MODIFIED — Ship 2: new MergeConflictIntent
    claude-code-launch-plugin.ts             # MODIFIED — Ship 2: intent dispatcher branch
specs/898-found-during-cockpit-v1/
  contracts/
    handler-contract.md                      # NEW — Ship 2 handler surface
    monitor-contract.md                      # NEW — Ship 2 monitor surface
    pause-comment-schema.md                  # NEW — Ship 1 stage-comment content
```

## Key files, existing anchors

- `packages/orchestrator/src/worker/phase-loop.ts:929-941` — pause-comment render site (`errorEvidence.mergeConflict.conflictedPaths`). Ship 1 mutates the shape rendered here.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:55` — shape template for `MergeConflictHandler`.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:689` — `addBlockedStuckFeedbackLoopLabel` precedent for `blocked:stuck-merge-conflicts`.
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:50` — shape template for `MergeConflictMonitorService`.
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:317-346` — `blocked:*` pre-enqueue skip check pattern.
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:354-402` — `enqueueIfAbsent` pattern with post-drop context log.
- `packages/orchestrator/src/services/label-monitor-service.ts:264` — `processLabelEvent` (kept unchanged — a new dedicated monitor is chosen over extending this).
- `packages/orchestrator/src/services/redis-queue-adapter.ts:113` — `enqueueIfAbsent` implementation; itemKey is `${owner}/${repo}#${issueNumber}`.
- `packages/orchestrator/src/worker/claude-cli-worker.ts:284-310` — dispatch discriminator; Ship 2 adds a peer branch to the `'address-pr-feedback'` case.
- `packages/orchestrator/src/worker/base-merge.ts:15-28` — `BaseMergeResult` type; the handler's post-agent verification will reuse `conflictedPaths` computation (via a re-run of `git diff --name-only --diff-filter=U`).
- `packages/orchestrator/src/worker/base-merge.ts:67-76` — `resolveBaseBranch` — handler reuses.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:680-710` — `listOpenPullRequests`; call site for the FR-005 same-base-in-repo enumeration.
- `packages/workflow-engine/src/actions/github/label-definitions.ts:43` — `waiting-for:merge-conflicts` (already present from `#864`).
- `packages/workflow-engine/src/actions/github/label-definitions.ts:100-111` — `blocked:stuck-feedback-loop` precedent; `blocked:stuck-merge-conflicts` inserts here.
- `packages/orchestrator/src/worker/label-manager.ts:100-150` — `onPhaseComplete` and `onGateHit`; the success path in Ship 2 calls `addLabels([completed:merge-conflicts])` + `removeLabels([waiting-for:merge-conflicts, agent:paused])`.

## Sequencing (ordered)

**Ship 1** (P0 — lands FIRST in commit history so the interim state is immediately live even if Ship 2 finds late blockers):
1. `label-definitions.ts` description update for `waiting-for:merge-conflicts` (docstring expansion is the "docs" half of FR-013).
2. `phase-loop.ts:929-941` — extend the pause-comment path so `stageCommentManager.updateStageComment` receives the three-step remedy text alongside `errorEvidence.mergeConflict`. Two implementation shapes are considered — see `research.md` §"Pause-comment injection point" for the pick.
3. `phase-loop.merge.test.ts` — assert the new content is rendered.

**Ship 2** (P1):
4. `label-definitions.ts` — add `blocked:stuck-merge-conflicts`.
5. `types/monitor.ts` — `QueueItem.command` union += `'resolve-merge-conflicts'`; add `ResolveMergeConflictsMetadata`.
6. `merge-conflict-prompt.ts` — pure prompt builder (input: `{ conflictedPaths, siblingOwnedPaths, baseRef, branch }` → structured prompt string).
7. `merge-conflict-handler.ts` — the class. Flow per `contracts/handler-contract.md`.
8. `claude-code-launch-plugin.ts` — new `MergeConflictIntent` branch (thin, reuses the same launcher plumbing as `PrFeedbackIntent`).
9. `merge-conflict-monitor-service.ts` — poll loop, enqueue, `blocked:*` skip.
10. `claude-cli-worker.ts:285` — add the `'resolve-merge-conflicts'` dispatch branch.
11. `server.ts` — construct + start the monitor alongside `PrFeedbackMonitorService`.
12. Unit tests for handler + monitor.

## Constitution check

No `.specify/memory/constitution.md` — none required. This plan preserves the load-bearing invariants derived from linked issues:

- `#862 / #879` — sole dedupe mechanism is `enqueueIfAbsent(itemKey)`. The retired `phase-tracker:*:resume:*` key pattern is **not** reintroduced (Q2).
- `#883` — one autonomous attempt scoped to the agent-CLI invocation itself; `blocked:*` on failure; block-removal re-enables the next poll naturally (Q4 → D + Q2).
- `#864` — pre-phase base-merge shape is unchanged; this plan only extends the pause-comment content and consumes the pause label.
- `#892 Q4` — same-base-in-repo open-PR enumeration is the FR-005 mechanic, **not** `context.linkedPRs` alone (Q3 corrected).

## Testing strategy

- **Unit** — `MergeConflictHandler` tests exercise: (1) tractable single-file conflict → agent produces conflict-free merge → push + `completed:merge-conflicts` applied; (2) agent-CLI exits without a merge → `blocked:stuck-merge-conflicts` + `waiting-for` preserved + evidence block; (3) sibling-owned file present → prompt tags it and forbids `--theirs/--ours` (assert the string emission, not agent behavior); (4) pre-agent fetch fails 2× then succeeds → attempt not spent; (5) post-agent push fails 2× then succeeds → treated as success.
- **Unit** — `MergeConflictMonitorService`: poll detects pause state → `enqueueIfAbsent` called; `blocked:stuck-merge-conflicts` present → skip; in-flight collision → drop with reason log.
- **Integration** — extend `phase-loop.merge.test.ts` to assert the new stage-comment content (Ship 1 SC-004).
- **Regression fixture** — SC-002/SC-003 synthetic `CLAUDE.md` conflict replay: constructed at test-runtime via a scratch git repo, not a real repo hit.

## Risks and mitigations

- **Risk**: the sibling-scope-guard `listOpenPullRequests` call adds a `gh` invocation per pause. **Mitigation**: gated to only fire when there is at least one conflicted path; result cached inside the handler for the duration of the single attempt. Miss window is a full poll cycle — acceptable per spec Assumptions.
- **Risk**: `git merge origin/<base>` on a stale local branch may push an obsolete commit if a concurrent push landed. **Mitigation**: fetch `origin/<branch>` and confirm `HEAD == origin/<branch>` before merging; if drift detected, `git reset --hard origin/<branch>` before merge (this is the pre-agent retry contract).
- **Risk**: the agent CLI silently produces a merge with unresolved conflict markers. **Mitigation**: post-agent verification runs `git diff --name-only --diff-filter=U` and `grep -l '<<<<<<< '` across staged files; either finding sends the handler to Disposition B (blocked + evidence). This is what `contracts/handler-contract.md` §"Success predicate" enforces.
- **Risk**: enqueue fires on issues that were already resolved out-of-band. **Mitigation**: handler's first act is to fetch the branch and check if the merge is a no-op (`git merge-base --is-ancestor origin/<base> HEAD`); if so, immediately clear `waiting-for:merge-conflicts` and exit success without spending the attempt (guardrail against operators clearing the block label without the label triple).

## Success measurement

Mirrors `spec.md` SC-001 through SC-005. Notably:

- **SC-002 (≥ 80% auto-resolve on tractable conflicts)** — measured by the regression fixture: synthetic `CLAUDE.md` conflict on a synthetic branch → handler runs to green in the fixture.
- **SC-004 (100% self-describing pause comments)** — grep the fixture-rendered stage comment for the three canonical remedy lines (verbatim string match against the FR-011 template).
- **SC-005 (100% advance-without-resolve re-pause names paths)** — fixture reruns the phase after simulating an unresolved advance; assert the second stage comment contains the same conflicted-path list.

## Out of scope

Restates `spec.md` §"Out of Scope" — no webhook-driven base-sync, no multi-attempt resolution, no cross-PR coordination, no merge-strategy tuning, no backlog scan for pre-existing paused issues, no changes to `#864` pre-phase merge semantics.

## Next step

`/speckit:tasks` to generate the task list from this plan.
