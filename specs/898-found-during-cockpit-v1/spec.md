# Feature Specification: waiting-for:merge-conflicts is a dead-end gate — #864's deferred conflict-resolution handler was never filed

**Branch**: `898-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #44.

#864 shipped the guardrail (pre-phase base-merge) and the pause label (`waiting-for:merge-conflicts` + `completed:merge-conflicts`) but deferred the bounded conflict-resolution subagent to a follow-up issue (Q4 → B: "The subagent is a follow-up issue"). **That follow-up was never filed.** Consequences observed post-#889/#890/#891/#892:

`cockpit resume` re-armed #6/#7/#8, the re-runs hit the base-merge `CLAUDE.md` conflict, and the pause path — now that its label exists — paused cleanly: all three issues sit at `waiting-for:merge-conflicts` + `agent:paused`. **Then nothing.** Nothing can ever happen:

1. **No automated resolver exists.** #864's deferral moved the bounded conflict-resolution subagent out of v1 scope; the follow-up was never filed. There is no consumer of the pause: label-monitor never enqueues a resolution item, and no worker handler exists to process one.
2. **No manual path is documented.** The gate participates in the standard pair protocol, but nowhere is it written what an operator must actually do. `cockpit advance --gate merge-conflicts` on its own just re-runs the phase, whose pre-merge hits the same conflict and re-pauses — a loop that looks like progress. The correct sequence (resolve conflict *on the branch*, push, *then* advance) is not documented anywhere and not surfaced in the pause comment.
3. #864's Assumption "the reactive remedy already exists (cockpit merge's fixer subagent, plus human resolution via the new gate)" turned out to be false — cockpit merge's fixer subagent fires at *merge time* after CI is red, not at *pre-phase merge conflict time* against `origin/<base>`, and "human resolution via the new gate" was never given mechanics.

Live impact: the entire P2 phase stalled indefinitely; the auto session waited on a state that cannot transition.

## Observed

Post-#889/#890/#891/#892 deploy:

- `cockpit resume` re-armed #6/#7/#8 (verb works — #891 landed).
- Re-runs hit the base-merge `CLAUDE.md` conflict (guardrail from #864 fires).
- Pause path paused cleanly: `waiting-for:merge-conflicts` + `agent:paused` applied (#864 FR-005 works).
- No transition possible from that state.

## Proposal

Two ships, both delivered together in a **single PR from this branch** (Q1 → A). Ship 1's content is not throwaway interim — the self-describing pause comment stays permanently load-bearing as the escalation surface for `blocked:stuck-merge-conflicts` (when Ship 2's one attempt fails, the operator needs exactly that manual path). There is no sequencing value in splitting; splitting Ship 2 into a follow-up is explicitly the missed-follow-up failure mode this issue exists to document.

### Ship 1 — Self-describing pause (interim path + permanent escalation surface)

The pause comment (via #865 alert) MUST carry the manual remedy verbatim. Same pattern as #874 FR-006's self-describing error: the state carries its own remedy. Concretely: when the worker pauses at `waiting-for:merge-conflicts`, the stage comment MUST render:

> **Merge conflict on base-merge.** Conflicted paths: `<paths>`. To resolve:
> 1. Check out `<branch>`, merge `origin/<base>`, resolve conflicts, commit, push.
> 2. Run `generacy cockpit advance <issue-ref> --gate merge-conflicts`.
> 3. Phase re-runs; pre-merge now succeeds; phase proceeds.
>
> Advancing without resolving first will re-pause with the same conflict.

Additionally, the label-protocol doc (wherever `waiting-for:*` labels are enumerated) MUST document this remedy alongside the label definition.

### Ship 2 — Engine-side merge-conflicts handler (primary, v1)

The promised follow-up. Shaped like `PrFeedbackHandler`:

- **Trigger**: label-monitor's poll detects `waiting-for:merge-conflicts` + `agent:paused` and enqueues a `resolve-merge-conflicts` queue item via `enqueueIfAbsent` on the itemKey (Q2). The **#862/#879 in-flight dedupe** pattern is the sole dedupe mechanism: webhook+poll races collapse; in-flight collisions drop with the structured reason line; handler completion self-clears. The retired `phase-tracker:*:resume:*` key pattern is NOT reintroduced. Blocked-state gating uses #883's semantics: the monitor skips enqueue while `blocked:stuck-merge-conflicts` is present; removing the label re-enables the next poll naturally (no keys to clear, no TTLs to tune).
- **Worker action**: check out branch, merge `origin/<base>` (which will conflict — that's what put us here), invoke the agent CLI with a bounded conflict-resolution prompt.
- **Termination discipline (#883, refined per Q4 → D)**: the "one autonomous attempt" is scoped to the **agent-CLI invocation itself**, which runs exactly once. Transient git/network operations get per-class retry budgets on both sides: pre-agent fetch/merge retries up to 3× with backoff, post-agent push retries up to 3× on network errors. The attempt is spent when the CLI is invoked; CLI-internal retries are the agent's problem. An index-lock or network flake that fails before agent invocation does NOT burn the attempt.
- **Scope guard (Q3 → A corrected)**: per-conflicted-file check. For each conflicted path, enumerate **open PRs targeting the same base branch in the repo** (the #892 Q4 mechanic — `gh pr list --base <base> --state open` or equivalent), NOT only `context.linkedPRs`. `linkedPRs` is the multi-repo linkage and misses same-repo siblings, which is precisely the observed case (sibling issues #6/#7/#8). If the conflicted path appears in any same-base open PR's file list, tag the file as "sibling-owned" in the agent prompt and forbid `git checkout --theirs` / `--ours` on it. The agent must produce a merged resolution on sibling-owned paths.
- **On success**: push the merge commit, clear the pause (`completed:merge-conflicts` + remove `agent:paused`), re-arm the phase. Pre-merge on the next run finds nothing to merge (branch already up-to-date), phase proceeds.
- **On failure**: add `blocked:stuck-merge-conflicts` label + evidence block enumerating attempted resolution and remaining conflicts. Do NOT retry. Human takes the manual path from Ship 1.

## User Stories

### US1: Merge-conflict pauses auto-resolve when the conflict is tractable

**As an** operator watching cockpit auto-mode,
**I want** the orchestrator to attempt a bounded, agent-driven resolution when a phase pauses at `waiting-for:merge-conflicts`,
**So that** tractable conflicts (like the CLAUDE.md conflict on #6/#7/#8) don't stall the auto session indefinitely — the same class of automation that #891's `cockpit resume` gave for failed phases, applied to merge-conflict pauses.

**Acceptance Criteria**:
- [ ] Label-monitor recognizes `waiting-for:merge-conflicts` + `agent:paused` as an enqueue trigger, analogous to `waiting-for:address-pr-feedback`.
- [ ] Enqueue uses `enqueueIfAbsent` on the itemKey (per #862/#879 in-flight dedupe); no `phase-tracker:*:resume:*` key is created or consulted.
- [ ] The monitor skips enqueue when `blocked:stuck-merge-conflicts` is present on the issue; removing the block label re-enables enqueue on the next poll.
- [ ] A `resolve-merge-conflicts` queue item is dispatched to a worker.
- [ ] The worker merges `origin/<base>` on the feature branch (not ephemerally — this merge is committed and pushed on success). Fetch/merge git operations retry up to 3× with backoff on transient errors before the agent-CLI is invoked.
- [ ] The worker invokes the agent CLI with a bounded conflict-resolution task exactly once (the agent-CLI invocation is the "one autonomous attempt").
- [ ] On successful resolution (conflict-free committed merge), the merge commit is pushed to the feature branch. Push retries up to 3× on transient network errors.
- [ ] On successful push, the handler applies `completed:merge-conflicts`, removes `waiting-for:merge-conflicts` and `agent:paused`. In-flight dedupe self-clears on handler completion; no external dedupe key manipulation is required.
- [ ] The phase re-arms; on next run, the base is already merged, so the pre-phase base-merge is a no-op, and the phase proceeds.

### US2: Unresolvable conflicts escalate loudly, not silently

**As an** operator watching cockpit auto-mode,
**I want** an agent that cannot resolve the conflict to stop with evidence and mark the issue as blocked,
**So that** an auto session doesn't chew credits in a retry loop, and I can see at a glance which issues need my hands vs. which are still cooking.

**Acceptance Criteria**:
- [ ] If the agent CLI exits without a conflict-free committed merge (agent gave up, or hit its stop condition per #883), the handler applies `blocked:stuck-merge-conflicts` and leaves `waiting-for:merge-conflicts` in place.
- [ ] The evidence block enumerates the conflicted paths that remain unresolved and any partial progress made.
- [ ] The handler does NOT re-invoke the agent on the same pause — one autonomous attempt only.
- [ ] Label-monitor's pre-enqueue `blocked:*` check keeps the loop paused until an operator removes the block label (existing #883 pattern).

### US3: The manual remedy is discoverable from the pause state

**As an** operator opening an issue paused at `waiting-for:merge-conflicts`,
**I want** the stage comment on that issue to state verbatim what I need to do (resolve on branch → push → cockpit advance),
**So that** I don't need to read #864's spec or the label-protocol doc to know that just running `cockpit advance` will re-pause. The state must carry its own remedy (same principle as #874 FR-006's self-describing error).

**Acceptance Criteria**:
- [ ] When the worker pauses at `waiting-for:merge-conflicts` (via #864's existing pause path), the stage comment renders the three-step remedy verbatim, listing the conflicted paths.
- [ ] The remedy explicitly warns that advancing without resolving will re-pause.
- [ ] The label-protocol doc enumerates the same remedy alongside the `waiting-for:merge-conflicts` label definition.

### US4: `cockpit advance --gate merge-conflicts` reports honestly when the branch is still conflicted

**As an** operator who ran `cockpit advance` without resolving,
**I want** the resulting re-pause to name the still-conflicted paths in the new stage comment,
**So that** the loop is at least loud and self-explaining — I can see that my advance did nothing productive.

**Acceptance Criteria**:
- [ ] When the phase re-runs after an advance-without-resolve, the pre-phase base-merge (#864 FR-013) re-detects the same conflict.
- [ ] The pause comment on the second pause names the same conflicted paths as the first pause (or the current set — the paths are re-computed from the merge attempt, not carried forward).
- [ ] No special-case detection is required — the existing #864 pause path already handles this; the requirement is only that the remedy text (US3) makes the causal link obvious.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The label-monitor MUST recognize `waiting-for:merge-conflicts` + `agent:paused` on an issue as an enqueue trigger, dispatching a `resolve-merge-conflicts` queue item. | P1 | Ship 2. Analogous to `waiting-for:address-pr-feedback` in existing label-monitor. |
| FR-002 | The `resolve-merge-conflicts` handler MUST check out the feature branch, fetch `origin/<base>` fresh, and perform `git merge origin/<base>` (committed, not ephemeral — this merge will be pushed on success). Pre-agent fetch/merge MUST retry up to 3× with backoff on transient errors (network, index lock) before the agent-CLI is invoked. | P1 | Ship 2. Base ref resolved per #864 FR-011 (open PR's `baseRefName`, fallback to repo default). Retry budget per Q4 → D. |
| FR-003 | The handler MUST invoke the agent CLI with a bounded conflict-resolution prompt when `git merge` reports conflicts, giving the agent access to the workspace to edit conflicted files. | P1 | Ship 2. Prompt shape mirrors `PrFeedbackHandler`'s structured prompt. |
| FR-004 | The handler MUST apply the #883 termination discipline: the "one autonomous attempt" is scoped to the **agent-CLI invocation itself**, which runs exactly once. The agent must either produce a conflict-free committed merge or stop with evidence. Pre-agent transient failures (retried per FR-002) do NOT count against the attempt. | P1 | Ship 2. Q4 → D: attempt = agent-CLI invocation only. |
| FR-005 | The handler MUST apply a per-conflicted-file scope guard: for each conflicted path, enumerate open PRs targeting the same base branch in the repo (via `gh pr list --base <base> --state open` or equivalent, the #892 Q4 mechanic). If the conflicted path appears in any such sibling PR's file list, the path MUST be tagged "sibling-owned" in the agent prompt and the agent MUST NOT use `git checkout --theirs` / `--ours` on that path — a merged resolution is required. Enumeration MUST include same-repo siblings, not only `context.linkedPRs`. | P1 | Ship 2. Q3 → A corrected: same-base-in-repo enumeration is load-bearing; `linkedPRs` alone misses the observed same-repo sibling case (#6/#7/#8). |
| FR-006 | On successful resolution (conflict-free committed merge), the handler MUST push the merge commit to the feature branch on origin. Post-agent push MUST retry up to 3× on transient network errors. | P1 | Ship 2. Retry budget per Q4 → D. |
| FR-007 | On successful push, the handler MUST apply `completed:merge-conflicts` and remove `waiting-for:merge-conflicts` and `agent:paused`. In-flight dedupe self-clears on handler completion; no external dedupe key manipulation is required. | P1 | Ship 2. Uses #862/#879 `enqueueIfAbsent` pattern; does NOT reintroduce the retired `phase-tracker:*:resume:*` pattern. |
| FR-008 | On agent-CLI failure (no conflict-free merge produced), the handler MUST apply `blocked:stuck-merge-conflicts` and leave `waiting-for:merge-conflicts` in place. It MUST NOT clear the pause. | P1 | Ship 2. Mirrors #883 `blocked:stuck-feedback-loop` disposition. |
| FR-009 | On agent-CLI failure, the handler MUST render an evidence block enumerating: conflicted paths that remain unresolved, and (if any progress was made) which paths were resolved partially. | P1 | Ship 2. Same evidence-block infra as #847. |
| FR-010 | Label-monitor's pre-enqueue `blocked:*` check MUST include `blocked:stuck-merge-conflicts` in its skip set, so the monitor skips enqueue while the block label is present. Removing `blocked:stuck-merge-conflicts` MUST re-enable enqueue on the next poll naturally (no keys to clear, no TTLs to tune). | P1 | Ship 2. Block-removal re-arm semantics per #883, delivered via the label state alone (Q2 answer). |
| FR-011 | The #864 pause comment (rendered by `phase-loop.ts` on `waiting-for:merge-conflicts` pause) MUST render the three-step manual remedy verbatim: (1) resolve on branch and push, (2) run `cockpit advance --gate merge-conflicts`, (3) phase re-runs. It MUST warn explicitly that advancing without resolving will re-pause. | P0 | Ship 1. Q5 → D: promoted to P0. |
| FR-012 | The pause comment MUST list the conflicted paths (already carried in `errorEvidence.mergeConflict` per #864) directly in the remedy text, not only in a separate evidence block. | P0 | Ship 1. Q5 → D: promoted to P0. |
| FR-013 | The label-protocol documentation (`packages/orchestrator/*` label docs / `workflow-engine/label-definitions.ts` companion) MUST document the manual remedy alongside `waiting-for:merge-conflicts`. | P0 | Ship 1. Q5 → D: promoted to P0 — agency#396's audit reads this doc, so it is load-bearing, not deferred polish. |
| FR-014 | Until Ship 2 lands (in this same PR), FR-011's self-describing pause comment plus FR-013's label-protocol docs are the sole path forward on merge-conflicts pauses; the handler does not exist yet. Ship 1 also remains permanently load-bearing as the escalation surface when Ship 2's one attempt fails (blocked state). | P0 | Ship 1 is the immediate unblocker; Ship 2 is the automation follow-up landing in the same PR (Q1 → A). |
| FR-015 | Ship 1 and Ship 2 MUST be delivered together in a single PR from this branch. Splitting Ship 2 into a follow-up issue is prohibited (this is the missed-follow-up failure mode that produced #898). | P0 | Q1 → A. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Issues sitting at `waiting-for:merge-conflicts` + `agent:paused` for > 30 minutes with no `blocked:*` label (evidence of a state that cannot transition). | 0 | Per auto-mode run, count issues in this state at run end. |
| SC-002 | Tractable merge-conflict pauses (single-file, non-sibling-PR conflicts) that auto-resolve without operator intervention. | ≥ 80% | Regression fixture: synthetic CLAUDE.md conflict from #864's #6/#7/#8 replay; verify handler resolves and phase proceeds. |
| SC-003 | Unresolvable merge-conflict cases that end in `blocked:stuck-merge-conflicts` (no retry loop, evidence surfaces). | 100% of unresolvable cases | Regression fixture: synthetic irreconcilable conflict; verify handler stops after one attempt with evidence, does not retry. |
| SC-004 | Operators can determine the manual remedy without reading spec docs. | 100% | The pause comment on any `waiting-for:merge-conflicts` pause names the three-step remedy verbatim. |
| SC-005 | `cockpit advance --gate merge-conflicts` executed without prior on-branch resolution produces a re-pause whose comment names the same (or updated) conflicted paths. | 100% | Regression fixture: pause → advance-without-resolve → verify re-pause + comment content. |

## Assumptions

- The pre-phase base-merge from #864 (FR-001/FR-002/FR-013) is the sole producer of `waiting-for:merge-conflicts` — no other code path applies this label. The handler in Ship 2 is the sole consumer.
- The agent CLI can be invoked with a workspace path and produce conflict-file edits + a merge commit, using the same launcher wiring as `PrFeedbackHandler`.
- #883's termination-discipline pattern (one autonomous attempt, `blocked:*` on failure, no retry) is directly applicable here — the agent-CLI shape is the same class of task; the attempt is scoped to the agent-CLI invocation, with bounded per-class retries for pre-agent and post-agent git operations (Q4 → D).
- The #862/#879 `enqueueIfAbsent` pattern is available on the queue and is the canonical in-flight dedupe for label-monitor-driven enqueues. The retired `phase-tracker:*:resume:*` key pattern (and its #849 paired-clear callback) is NOT reintroduced (Q2 answer).
- Same-base-branch open-PR enumeration for FR-005 is available via `gh pr list --base <base> --state open` (or the equivalent GitHub client method) and each PR's file list via `gh pr view --json files`. This is the #892 Q4 mechanic and is the load-bearing input to the per-file sibling scope guard. Same-repo siblings are the observed hazard case (#6/#7/#8); relying solely on `linkedPRs` misses them.
- The stage-comment rendering path from #864's pause is a single point where FR-011's remedy text is injected; no schema change to `errorEvidence` is required (the `mergeConflict.conflictedPaths` field already exists).

## Out of Scope

- **Webhook-driven or continuous base-sync** — v1's handler fires only when the pre-phase base-merge already paused. Standing base-sync (a job that pre-merges base into feature branches outside phase boundaries) remains out of scope per #864's own Out-of-Scope note.
- **Multi-attempt agent resolution** — one autonomous attempt only, per #883 discipline. Multi-attempt / escalation-gate flow is a follow-up (analogous to #883's own follow-up posture).
- **Sibling PR coordination** — v1's FR-005 scope-guards against taking a sibling's file wholesale (whether the sibling PR is same-repo targeting the same base branch or cross-repo via `linkedPRs`), but does not attempt cross-PR coordination (e.g., waiting for the sibling PR to merge before resolving). If the conflict *requires* a sibling PR to merge first, v1 stops with evidence.
- **Alternative merge strategies** (`ort`, `recursive` with rename-detection tuning, `-X ours`/`-X theirs`) — the handler uses git's default merge strategy; strategy tuning is a follow-up if empirically needed.
- **Auto-detection of `waiting-for:merge-conflicts` on issues that pre-date this handler's deployment** — the handler enqueues on new pause events (label-add), not on scanning existing issues. Operators clearing the historical backlog (like #6/#7/#8) use Ship 1's manual remedy for the first cycle after deploy.
- **Changing #864's pre-phase merge semantics** (ephemeral vs. committed, base ref resolution, phase coverage) — this spec builds on #864 as shipped; any change to that surface is out of scope.

---

*Generated by speckit*
