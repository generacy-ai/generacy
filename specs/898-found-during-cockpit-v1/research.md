# Research Notes: #898

Decisions, alternatives considered, and citations. All page anchors are `file:line` refs to code in this repo.

## 1. Monitor shape — extend `LabelMonitorService` vs. new `MergeConflictMonitorService`?

**Decision**: new service `MergeConflictMonitorService`, peer of `PrFeedbackMonitorService`.

**Alternatives**:

- **A: Extend `LabelMonitorService.pollRepo()`** (`packages/orchestrator/src/services/label-monitor-service.ts:486`) with a third loop over `waiting-for:merge-conflicts`. Wording in `spec.md` FR-001 says "the label-monitor MUST recognize…", which reads as a nudge in this direction.
- **B: New `MergeConflictMonitorService`** mirroring `pr-feedback-monitor-service.ts`, wired in `server.ts` alongside the existing two.
- **C: Merge into `PrFeedbackMonitorService`.** Rejected outright — its state maps (`lastUnresolvedThreadCount`, `lastZeroTrustedState` in `pr-feedback-monitor-service.ts:63-69`) are PR-thread-specific; conflating them adds unrelated state.

**Rationale for B**:

- `LabelMonitorService` handles `process:*` triggers and paired-resume detection off `completed:*` — different semantic surface. Its `parseLabelEvent` (`label-monitor-service.ts:264`) branches on `type: 'process' | 'resume'`; adding a third branch bloats the discriminator without shared logic.
- The `PrFeedbackMonitorService` precedent (`pr-feedback-monitor-service.ts:50`) has already carved out a "single-gate poll-based monitor for a specific `waiting-for:*` label" pattern. The merge-conflict monitor is the direct analog — a peer service in the same directory.
- Regression risk: `LabelMonitorService` is high-traffic and touches every issue in every watched repo per cycle. Adding a third loop increases GH REST API load unconditionally. A separate monitor lets us adaptive-poll it independently (paused issues at `waiting-for:merge-conflicts` are a small subset — polling faster on state change makes sense).
- FR-001's wording is not architectural — it names the observable behavior. The clarification (Q2) confirms `enqueueIfAbsent` + `blocked:*` skip, both patterns lifted from `PrFeedbackMonitorService`, not `LabelMonitorService`.

**Cost**: one more class + one more `.start()` call in `server.ts`. Cheap.

## 2. `enqueueIfAbsent` as sole dedupe (Q2 answer, hard-coded into design)

The `#849` paired `phase-tracker:*:resume:<gate>` key pattern is **not** reintroduced. Sole dedupe is `QueueManager.enqueueIfAbsent(item)` (`packages/orchestrator/src/types/monitor.ts:232`, implemented at `redis-queue-adapter.ts:113`).

- **itemKey shape**: `${owner}/${repo}#${issueNumber}` — one key per orchestrated issue. Two poll cycles firing at the same time both call `enqueueIfAbsent` → one wins, the other drops with a structured log line. Handler completion self-clears via `QueueManager.complete()`.
- **`blocked:stuck-merge-conflicts` gating**: pre-enqueue check in the monitor iterates issue labels and skips if any label starts with `blocked:` (mirrors `pr-feedback-monitor-service.ts:317-346`). No key, no TTL — the label is the state. Operator removes the label → next poll re-enters naturally.
- **Why not `phase-tracker` keys**: `#862` retired the resume-branch keys and `#879` finished the removal. Reintroducing them here would reopen the same bug surface (stale keys stranding legitimate re-enqueues after a handler completion, the exact class the spec's Q2 answer forbids).

## 3. "One autonomous attempt" scope (Q4 → D, hard-coded into design)

The attempt is spent when the **agent-CLI is invoked**. Pre-agent and post-agent transient failures do NOT burn the attempt.

- **Pre-agent**: `git fetch origin` + `git merge origin/<base>` retry up to 3× with backoff (250ms, 500ms, 1000ms — mirrors the existing `retryWithBackoff` shape in `label-manager.ts`). Retriable classes: `ECONNRESET`, `ETIMEDOUT`, exit code from stderr matching `index.lock` or `remote error: RPC failed`. Non-retriable (clean conflict output from git) does not retry — that's the expected path into the agent.
- **Agent-CLI**: invoked exactly once. Any exit is decisive.
- **Post-agent**: `git push origin <branch>` retries up to 3× on network errors only. A rejected push (non-fast-forward, remote-branch-diverged) does NOT retry — it means someone else pushed and the agent's merge is stale; the correct disposition is `blocked:stuck-merge-conflicts` with evidence.

**Why not option B** (entire handler run counts): converts infrastructure noise into `blocked:*` states an operator has to clear. Same transient/terminal distinction `#889` Q3 settled.

**Why not option C** (queue-item level, with the item retrying internally): the queue already has its own release/reclaim path; layering another retry loop on top mixes budget semantics.

## 4. Sibling scope guard — `linkedPRs` vs. `gh pr list --base` (Q3 → A corrected)

**Decision**: per-conflicted-file check against `gh pr list --base <base> --state open` output, cross-referenced with each PR's file list via `gh pr view --json files`. Same-repo siblings are the observed hazard case (`#6/#7/#8` at report time), which `context.linkedPRs` (cross-repo linkage from `#692`) misses by design.

**Implementation**:

- `GhCliGitHubClient.listOpenPullRequests(owner, repo)` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:680`) returns `PullRequest[]` with `baseRefName`. Filter by `pr.base.ref === baseRef` (the base branch we're merging in from — same one resolved via `base-merge.ts:67-76`).
- For each candidate sibling PR: `gh pr view <number> --json files` gives the file list. Cache the sibling file map for the single-attempt lifetime; do not re-query per conflicted path.
- Tag each conflicted path as `sibling-owned: true` if it appears in any sibling PR's file list; `false` otherwise.
- The agent prompt receives the tag list. The prompt text explicitly forbids `git checkout --theirs <path>` and `git checkout --ours <path>` on sibling-owned paths — a merged resolution is required. See `merge-conflict-prompt.ts` and `contracts/handler-contract.md` §"Sibling-owned path constraint".

**Why not option C** (advisory-only prompt without programmatic detection): a MUST-NOT scope guard cannot be enforced by advice alone. The spec is explicit (Q3 answer: "C's advisory-only version of a MUST-NOT is not a guard").

**Cost**: one `gh pr list` call + one `gh pr view --json files` per sibling PR discovered. Bounded by the number of open PRs targeting `<base>`.

## 5. Pause-comment injection point (Ship 1)

The `#864` pause site is at `phase-loop.ts:929-941`:

```ts
await deps.stageCommentManager.updateStageComment({
  stage,
  status: 'in_progress',
  phases: …,
  startedAt: …,
  prUrl: context.prUrl,
  errorEvidence: {
    mergeConflict: {
      baseRef: mergeResult.baseRef,
      conflictedPaths: mergeResult.conflictedPaths,
    },
  },
});
```

Two shapes considered:

- **A: Add a `manualRemedy` string to the `mergeConflict` field.** Requires `StageCommentManager` to render it. Data structure change but keeps the phase-loop caller declarative.
- **B: Extend `errorEvidence` with a new sibling field `manualRemedy: string[]` (line-per-step) rendered separately.** Same idea but not tied to `mergeConflict`.
- **C: Render the remedy text in `phase-loop.ts` and pass it as a pre-built string to `updateStageComment`.** Keeps `StageCommentManager` unchanged but couples the remedy content to the phase loop.

**Decision**: shape A. The `mergeConflict` block already carries conflict-specific fields; adding a `manualRemedy: { steps: string[]; warning: string }` sub-field keeps the shape coherent. `StageCommentManager` gains a small render change (bullet list + a callout for the "advancing without resolving will re-pause" warning). This lets other pause sites in the future adopt the same "state carries its own remedy" pattern.

The remedy text is defined as a module-level constant `MERGE_CONFLICT_REMEDY` in a new `worker/merge-conflict-remedy.ts` (small, testable) so both the phase-loop call site and the label-protocol docs render from the same source. See `contracts/pause-comment-schema.md`.

## 6. Success predicate for the agent-CLI attempt

Reading a `git merge --no-commit` result programmatically is the load-bearing verification. Two failure modes matter:

- **Agent left conflict markers in files without staging.** `git diff --name-only --diff-filter=U` returns paths with unresolved markers. Any nonempty output → Disposition B.
- **Agent staged files but the merge is still incomplete.** `git status --porcelain=v2 --branch` shows `# branch.ab` counts and per-file state. If `MERGE_HEAD` still exists in `.git/`, the merge was not completed. Alternatively, `git commit` before check: if the agent hasn't committed, we do NOT commit for it — Disposition B. Requiring the agent to produce the commit itself is the crisper contract and matches `PrFeedbackHandler`'s "did the CLI produce a diff we can push" test.

**Decision**: the handler runs the merge → agent → then checks `[ -f .git/MERGE_HEAD ]`. Presence → Disposition B ("agent did not complete the merge"). Absence → verify no conflict markers via `git diff --name-only --diff-filter=U` (should be empty because merge is committed) and grep for `<<<<<<< ` in the staged files as belt-and-suspenders. All-clear → push.

## 7. Regression fixture strategy

Two fixture-worthy behaviors:

- **SC-002 tractable auto-resolve** — a synthetic single-file `CLAUDE.md` conflict where both sides added unrelated lines at the top of the file. This is the reproducible `#6/#7/#8` observed shape.
- **SC-003 unresolvable-conflict blocked disposition** — a synthetic irreconcilable conflict (same line, incompatible edits, no clear merge). The agent CLI is mocked to exit without producing a merge commit; the handler must apply `blocked:stuck-merge-conflicts` + evidence.

**Approach**: both fixtures live in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts`. The test constructs a scratch git repo in `os.tmpdir()`, seeds a base and a feature branch with predetermined conflict content, mocks `AgentLauncher.launch()` to either apply a resolution (Case 1) or exit non-zero (Case 2), and asserts on the label mutations + push outcome via a mocked `GitHubClient`.

## 8. Label additions and label-protocol docs (FR-013)

`packages/workflow-engine/src/actions/github/label-definitions.ts` already has `waiting-for:merge-conflicts` at line 43 (added by `#864`). Ship 1 expands the `description` field to name the manual remedy in a compact form (label descriptions are limited to 100 chars per GitHub API; the full remedy lives in the stage comment). The label-protocol doc referenced in FR-013 is the same `label-definitions.ts` file — that IS the label-protocol source of truth in this repo (there is no separate `.md` doc).

`blocked:stuck-merge-conflicts` is a new entry, mirroring `blocked:stuck-feedback-loop` (`label-definitions.ts:100`) and `blocked:stuck-validate-fix` (`:107`) shape.

## 9. Intent plumbing (`MergeConflictIntent`)

`packages/generacy-plugin-claude-code/src/launch/types.ts` already has `PrFeedbackIntent` (line 26) and `ValidateFixIntent` (line 39). We add a peer:

```ts
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  /** For logging/tracing */
  issueNumber: number;
  /** Full prompt (built by MergeConflictHandler with conflictedPaths + sibling tags) */
  prompt: string;
}
```

`claude-code-launch-plugin.ts` dispatches on `intent.kind`. The `'merge-conflict'` branch reuses the same launcher plumbing as `'pr-feedback'` — no new command shape, just a different prompt content.

## 10. References

- `spec.md`, `clarifications.md` (this feature).
- `#864` — pre-phase base-merge guardrail. Anchor: `packages/orchestrator/src/worker/base-merge.ts`, `phase-loop.ts:895-951`.
- `#862`, `#879` — `enqueueIfAbsent` in-flight dedupe. Anchor: `packages/orchestrator/src/services/redis-queue-adapter.ts:113`.
- `#883` — one-attempt termination + `blocked:*` label. Anchor: `packages/orchestrator/src/worker/pr-feedback-handler.ts:41-53, 689-707`.
- `#892 Q4` — same-base-in-repo enumeration. Anchor: `packages/workflow-engine/src/actions/github/client/gh-cli.ts:680`.
- `#849` — retired `phase-tracker:*:resume:*` pattern (NOT reintroduced).
- `#874 FR-006` — "state carries its own remedy" pattern that Ship 1 mirrors.
- `#889 Q3` — transient/terminal error distinction that informs the "one attempt" scoping.
- `#692`, `#687` — multi-repo `linkedPRs` / `siblingWorkdirs` (NOT sufficient for FR-005 per Q3 correction).
