# Research: Prevent worker from resurrecting deleted branches and cross-contaminating issues

## R1 — Why `--prune` on `git fetch origin` is the correct minimal fix

**Decision**: Add `--prune` to both `execFileAsync('git', ['fetch', 'origin'], ...)` invocations in `repo-checkout.ts` — `switchBranch:109` and `updateRepo:224`. Leave `fetchBase:143` untouched (single-ref fetch, `--prune` has no effect).

**Rationale**: The observed field failure was not a git-fetch bug — `fetch origin` correctly does not delete stale remote-tracking refs by default. Per git-fetch(1) manpage on `--prune` / `-p`: *"Before fetching, remove any remote-tracking references that no longer exist on the remote."* Without this flag, a remote-tracking ref for a branch that has been deleted upstream continues to resolve locally. The failure is in *composition*: the subsequent `git checkout <branch>` at `:112` / `:228` silently succeeds against the stale local ref (because the local branch still exists from the prior run), so the "Local branch not found" fallback at `:114` / `:230` never fires, and `reset --hard origin/<branch>` completes against the still-cached `origin/<branch>` ref. `--prune` deletes the stale `origin/<branch>` tracking ref, which then invalidates the local branch's upstream — the checkout may still succeed but the subsequent `reset --hard origin/<branch>` fails loudly with `ambiguous argument 'origin/<branch>'` (verified locally).

_(PR #1052 review Finding 11 correction: the citation previously quoted the `--no-tags` paragraph, not the `--prune` paragraph. Replaced with the actual `--prune` text.)_

**Alternatives considered**:

- *`git checkout -B ... origin/<branch>` unconditionally* — invasive rewrite of the switch logic; would still not detect a merged-and-deleted branch without a prior fetch --prune (the tracking ref would still be present pre-prune).
- *Test remote branch existence explicitly with `git ls-remote --heads origin <branch>` inside `switchBranch`* — one extra network call per phase entry vs. `--prune`'s piggyback on the existing fetch. `--prune` is strictly cheaper.
- *Full `git remote prune origin` before every phase* — semantically identical to `--prune` on the fetch itself; less standard idiom.

**Reference sources**:

- `repo-checkout.ts:105-118` (switchBranch fetch → checkout → reset sequence)
- `repo-checkout.ts:218-242` (updateRepo fetch → checkout → reset sequence)
- git-fetch(1) manpage, `--prune` / `-p` documentation
- Live repro at generacy-cloud#883 (spec.md § Observed instance)

## R2 — Why `findPRForBranchAnyState` is a new method, not a parameter

**Decision**: Add a new method `findPRForBranchAnyState(owner, repo, branch): Promise<PullRequest | null>` on the `GitHubClient` interface (implemented in `GhCliGitHubClient`) that runs `gh pr list --state all --head <branch> --json ...`. Do NOT change `findPRForBranch`'s signature.

**Rationale**: Q2 clarification names five call sites depending on `findPRForBranch`'s open-only default:

| Call site | Behavior depended on |
|-----------|----------------------|
| `pr-manager.ts:167` (`tryAdoptCanonicalPr`) | Open-only — the dedup probe explicitly wants "is there another OPEN PR on this canonical branch". |
| `pr-manager.ts:244` (`ensureDraftPr`) | Open-only — first-phase probe should NOT adopt a merged/closed PR. |
| `sibling-fanout.ts` × 2 | Multi-repo fanout wants sibling PRs that are currently open. |
| Mocks in tests | Mirror open-only assumption. |

A `state?: 'open' | 'all' | 'closed' | 'merged'` parameter with a default is technically compatible, but every review of `findPRForBranch(...)` now must confirm no third arg was omitted at a site that meant to pass `'all'`. A dedicated method makes intent explicit and unmissable.

**Alternatives considered**:

- *Parameter with `default = 'open'`* — silent-typo risk (see above). Rejected.
- *Reuse `listPullRequests` with a filter* — much heavier API surface (paginates, returns all PRs across the repo). Rejected.
- *Direct `gh` invocation inside `push-guard.ts`* — bypasses the `GitHubClient` seam; every existing worker test that stubs the client would have a hole. Rejected.

**Reference sources**:

- `gh-cli.ts:890-926` (existing `findPRForBranch` shape — reuse this exact `--json` schema in the new method).
- Q2 clarification's live gh CLI verification against `884-problem-refreshaccesstoken`.

## R3 — Why the pre-push guard runs at TWO invocation sites per phase

**Decision**: Invoke the guard (a) immediately after `switchBranch` at phase start in `phase-loop.ts`, and (b) immediately before `commitPushAndEnsurePr` in `pr-manager.ts` and the `commitAndPushChanges` push call site in `pr-feedback-handler.ts:670`.

**Rationale**: Q5 clarification identifies the "no-op phase" hole — if a phase produces `hasChanges: false`, no push fires, so a pre-push-only gate never runs. The phase then silently completes on a merged issue. The post-`switchBranch` check catches this: `switchBranch` is where the stale ref actually resolves (`reset --hard origin/<branch>`), so a merged-branch state is visible at that point. Cost: one extra `gh pr list --state all` + one `git ls-remote` per phase (phases are minutes long; two API calls are amortized).

**Alternatives considered**:

- *Pre-push only* (Option A of Q5) — leaves the no-op-phase hole. Rejected.
- *Before every commit within a phase* (Option C of Q5) — N calls per phase for zero incremental coverage. Rejected.
- *One combined check inside `switchBranch`* — couples the git-layer helper to the GitHub layer; introduces a client dependency where none exists today. Rejected — keep the guard at the caller.

**Reference sources**:

- Q5 clarification and rationale.
- `phase-loop.ts:180-289` (phase-loop structure: label update → base merge → phase execute → commit/push).
- `pr-feedback-handler.ts:154` (`switchBranch` invocation in the PR-feedback handler).

## R4 — RETRACTED (PR #1052 review Finding 5)

**Original decision**: rely on existing `git reset --hard HEAD` + `git clean -fd` for cross-issue working-tree isolation, backed by a regression test.

**Retraction rationale**: The observed contamination premise on `d8e392ca` was inferred from `gh api ... commits/d8e392ca` showing "every file belongs to #880". That output is an artifact of GitHub diffing merge commits against parent 1 only. `d8e392ca` actually has TWO parents (`c3cbe0e4` = pre-merge tip, `5542e900` = squash-merge of PR #881); files coming in via parent 2 render as `added`. It is a routine `develop` base-merge, not a single-parent commit with a contaminated working tree. The prior R4 rationale — *"the reset resolved to the pre-merge tip, which by coincidence had issue-B's files"* — is self-refuting: files already present on the tip cannot render as `added`. Corroborated by generacy-cloud#886 which resurrected `884-problem-refreshaccesstoken` with no foreign files at all. Cross-issue contamination is not a real failure mode in the observed evidence, so FR-004, SC-003, and the corresponding regression test have all been cut.

## R5 — Why FR-003b splits label state on issue-open state at refusal time

**Decision**: On refusal, always clear `agent:in-progress`. Then split:

| Issue state at refusal | Additional action | Rationale |
|------------------------|-------------------|-----------|
| `closed` | (none) — no `agent:error`, no comment | Silent — noise on closed issue nobody sees. |
| `open` | Add `agent:error` (no comment) | Genuine anomaly (open issue + merged/missing branch) requires operator visibility. |

Never add `failed:<phase>`.

**Rationale**: Q3 clarification. `failed:<phase>` invites `/cockpit:resume` to re-run the phase against merged work, which re-attempts the refused push — the fix becomes a loop. `agent:error` on a closed issue is noise (operators filter by open state). The split preserves the "silent on expected steady-state, loud on genuine anomaly" invariant.

**Alternatives considered**:

- *Always add `agent:error`* (Option B of Q3) — noisy on closed issues. Rejected.
- *Add `failed:<phase>` for cockpit-resume compatibility* (Option C) — loop. Rejected.
- *Silent everywhere* — leaves stalled open issue with no signal. Rejected.

**Reference sources**:

- Q3 clarification.
- `pr-feedback-handler.ts:608-617` — existing `finally` clear pattern for `agent:in-progress` (#926 SC-004).
- #849's re-arm-on-failure mechanics that would misfire on `failed:<phase>` here.

## R6 — Structured `event: 'push-refused'` log field shape

**Decision**: Emit exactly one `warn`-or-above log line per refusal with fields:

```
{
  event: 'push-refused',
  reason: 'pr-merged' | 'pr-closed' | 'branch-missing',
  prNumber: number | null,
  branch: string,
  owner: string,
  repo: string,
  issueNumber: number,
}
```

**Rationale**: Q4 clarification. Neutral event name (`push-refused`) is future-reusable for other push-refusal paths that might appear later; the `reason` enum carries the specificity. `branch-resurrection-prevented` (Option B) is wrong for two of its three reason values (nothing is "resurrected" when the reason is `pr-merged` or `pr-closed` and the branch still exists). Inline warn strings without `event:` (Option C) are the status quo that made this bug invisible for months.

**Reference sources**:

- Q4 clarification.
- Existing structured log conventions at `pr-feedback-handler.ts:224` (`event: 'comment-skipped'`) and `pr-manager.ts:177` (`event: 'workflow-reentry-branch-mismatch'`).

## R7 — Why FR-005 applies to both `process` and `resume` events

**Decision**: In `LabelMonitorService.processLabelEvent()`, gate on `issue.state === 'closed'` for both `type === 'process'` and `type === 'resume'` events.

**Rationale**: Q1 clarification. The observed repro (`chore(speckit): complete validate phase for #879`) was emitted from a resume event, not a fresh process event. A process-only gate would miss the exact field failure mode this spec exists to fix. A drop here is *expected steady-state behavior* — closing an issue mid-workflow is legal; the previously-enqueued resume event should be silently ignored. Emit at `info` level with `dropped: 'issue-closed'`, not `warn` or `error` (Q1-C rejected).

**Alternatives considered**:

- *Process-only gate* (Q1-B) — misses the field failure mode. Rejected.
- *Both, treat resume-on-closed as error* (Q1-C) — `agent:error` on closed issue is invisible to operators (Q3 rationale). Rejected.

**Reference sources**:

- Q1 clarification and observed repro evidence.
- `label-monitor-service.ts:280-346` (`processLabelEvent` structure and existing dedup site).

## R8 — Composition with #1049 and #1043

**Decision**: FR-005's dispatch gate coexists with, does not replace, #1049's `PrFeedbackMonitorService` merged-PR gate. FR-002's pre-push guard coexists with, does not replace, #1043's `resolveIssueBranch` PR-adoption probe in `pr-manager.ts`.

**Rationale**:

- #1049 gates the `address-pr-feedback` entry path (webhook / label-monitor for `pr-feedback-received`). It does NOT gate `process` / `resume` events on the phase-loop path — which is where this spec's observed repro landed.
- #1043 dedups the *branch-selection* step during `ensureDraftPr` (chooses the oldest open PR's branch as canonical). It does NOT check whether a merged PR's branch was resurrected — the resolver returns null for merged PRs and pr-manager falls through to open a new draft on the (resurrected) current branch. FR-002's guard fires *before* the push happens, so the branch is never recreated in the first place.

The three fixes compose:

1. FR-005 drops the doomed job at enqueue (defense in depth). (Note: FR-005 gates `processLabelEvent` only; four other enqueue paths are out of scope per PR #1052 review Finding 9.)
2. If FR-005 misses (issue closes after enqueue, or the enqueue arrives via one of the other four paths), FR-002 catches at phase-start / pre-push.
3. If FR-002 misses (extraordinary race), FR-001 makes the checkout state visible and `reset --hard origin/<branch>` fails loudly on a pruned branch.
4. #1043 continues to dedup the branch-selection step for the normal (non-merged) path.
5. #1049 continues to gate pr-feedback (a different entry path).

**Reference sources**:

- Spec §Relationship to #1049.
- #1043 architecture summary in CLAUDE.md.

## Key sources

- Live repro: `generacy-ai/generacy-cloud#883`, `PR #882` (deleted branch), `commit d8e392ca` (orphan).
- Prior gate: PR #1050 (#1049 fix landed).
- Sibling fix: #1043 branch resolution + adoption probe.
- Sibling fix: #849 pause-paired dedupe clear (label-monitor mechanics reference).
- git-fetch(1) manpage `--prune` semantics.
- `gh pr list --state all` verification against 884-problem-refreshaccesstoken branch (Q2 clarification).
