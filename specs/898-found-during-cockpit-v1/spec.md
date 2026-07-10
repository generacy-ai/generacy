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

Two ships, one small (documentation) shipped first as the interim, the second (handler) as the primary v1.

### Ship 1 — Self-describing pause (interim, ships first)

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

- **Trigger**: label-monitor detects `waiting-for:merge-conflicts` + `agent:paused` and enqueues a `resolve-merge-conflicts` queue item (analogous to `address-pr-feedback`).
- **Worker action**: check out branch, merge `origin/<base>` (which will conflict — that's what put us here), invoke the agent CLI with a bounded conflict-resolution prompt.
- **Termination discipline (#883)**: the agent MUST produce a conflict-free committed merge or stop with evidence. One autonomous attempt; more only via the escalation gate (`blocked:stuck-merge-conflicts` per #883 pattern).
- **Scope guard (#892 FR-011)**: NEVER resolve by taking a sibling's file wholesale when that sibling's PR is open. The resolver must respect other open PRs' changes.
- **On success**: push the merge commit, clear the pause (`completed:merge-conflicts` + remove `agent:paused`), re-arm the phase. Pre-merge on the next run finds nothing to merge (branch already up-to-date), phase proceeds.
- **On failure**: add `blocked:stuck-merge-conflicts` label + evidence block enumerating attempted resolution and remaining conflicts. Do NOT retry. Human takes the manual path from Ship 1.

## User Stories

### US1: Merge-conflict pauses auto-resolve when the conflict is tractable

**As an** operator watching cockpit auto-mode,
**I want** the orchestrator to attempt a bounded, agent-driven resolution when a phase pauses at `waiting-for:merge-conflicts`,
**So that** tractable conflicts (like the CLAUDE.md conflict on #6/#7/#8) don't stall the auto session indefinitely — the same class of automation that #891's `cockpit resume` gave for failed phases, applied to merge-conflict pauses.

**Acceptance Criteria**:
- [ ] Label-monitor recognizes `waiting-for:merge-conflicts` + `agent:paused` as an enqueue trigger, analogous to `waiting-for:address-pr-feedback`.
- [ ] A `resolve-merge-conflicts` queue item is dispatched to a worker.
- [ ] The worker merges `origin/<base>` on the feature branch (not ephemerally — this merge is committed and pushed on success).
- [ ] The worker invokes the agent CLI with a bounded conflict-resolution task; the agent has one autonomous attempt.
- [ ] On successful resolution (conflict-free committed merge), the merge commit is pushed to the feature branch.
- [ ] On successful push, the handler applies `completed:merge-conflicts`, removes `waiting-for:merge-conflicts` and `agent:paused`, and clears the paired resume-dedupe key (#849 pattern).
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
| FR-002 | The `resolve-merge-conflicts` handler MUST check out the feature branch, fetch `origin/<base>` fresh, and perform `git merge origin/<base>` (committed, not ephemeral — this merge will be pushed on success). | P1 | Ship 2. Base ref resolved per #864 FR-011 (open PR's `baseRefName`, fallback to repo default). |
| FR-003 | The handler MUST invoke the agent CLI with a bounded conflict-resolution prompt when `git merge` reports conflicts, giving the agent access to the workspace to edit conflicted files. | P1 | Ship 2. Prompt shape mirrors `PrFeedbackHandler`'s structured prompt. |
| FR-004 | The handler MUST apply the #883 termination discipline: one autonomous agent attempt; the agent must either produce a conflict-free committed merge or stop with evidence. | P1 | Ship 2. No retry loop. |
| FR-005 | The handler MUST apply the #892 FR-011 scope guard: if a conflict involves a file also modified by a sibling issue whose PR is still open, the agent MUST NOT resolve by taking that sibling's file wholesale. | P1 | Ship 2. Preserves multi-repo/sibling-workflow safety. |
| FR-006 | On successful resolution (conflict-free committed merge), the handler MUST push the merge commit to the feature branch on origin. | P1 | Ship 2. |
| FR-007 | On successful push, the handler MUST apply `completed:merge-conflicts`, remove `waiting-for:merge-conflicts` and `agent:paused`, and clear the paired resume-dedupe key. | P1 | Ship 2. Uses existing #849 paired-clear callback pattern. |
| FR-008 | On agent-CLI failure (no conflict-free merge produced), the handler MUST apply `blocked:stuck-merge-conflicts` and leave `waiting-for:merge-conflicts` in place. It MUST NOT clear the pause. | P1 | Ship 2. Mirrors #883 `blocked:stuck-feedback-loop` disposition. |
| FR-009 | On agent-CLI failure, the handler MUST render an evidence block enumerating: conflicted paths that remain unresolved, and (if any progress was made) which paths were resolved partially. | P1 | Ship 2. Same evidence-block infra as #847. |
| FR-010 | Label-monitor's pre-enqueue `blocked:*` check MUST include `blocked:stuck-merge-conflicts` in its skip set. | P1 | Ship 2. Prevents retry loop when human clears `waiting-for:*` but leaves the block label. |
| FR-011 | The #864 pause comment (rendered by `phase-loop.ts` on `waiting-for:merge-conflicts` pause) MUST render the three-step manual remedy verbatim: (1) resolve on branch and push, (2) run `cockpit advance --gate merge-conflicts`, (3) phase re-runs. It MUST warn explicitly that advancing without resolving will re-pause. | P1 | Ship 1 — the interim, ships before Ship 2. |
| FR-012 | The pause comment MUST list the conflicted paths (already carried in `errorEvidence.mergeConflict` per #864) directly in the remedy text, not only in a separate evidence block. | P1 | Ship 1. |
| FR-013 | The label-protocol documentation (`packages/orchestrator/*` label docs / `workflow-engine/label-definitions.ts` companion) MUST document the manual remedy alongside `waiting-for:merge-conflicts`. | P2 | Ship 1. Documentation is the second reader; the comment (FR-011) is the primary. |
| FR-014 | Until Ship 2 lands, FR-011's self-describing pause comment is the sole path forward on merge-conflicts pauses; the handler does not exist yet, and the interim behavior is human-only resolution via the documented remedy. | P0 | Ship 1 is the immediate unblocker; Ship 2 is the automation follow-up. |

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
- #883's termination-discipline pattern (one autonomous attempt, `blocked:*` on failure, no retry) is directly applicable here — the agent-CLI shape is the same class of task.
- #849's paired resume-dedupe clear callback is already reachable from the handler (via `LabelManager` or its callback surface).
- The stage-comment rendering path from #864's pause is a single point where FR-011's remedy text is injected; no schema change to `errorEvidence` is required (the `mergeConflict.conflictedPaths` field already exists).
- Sibling-repo/PR detection for FR-005 uses the existing multi-repo linked-PR state (#692 `linkedPRs` + #687 `siblingWorkdirs`); the handler receives it via `WorkerContext` the same way phase-loop does.

## Out of Scope

- **Webhook-driven or continuous base-sync** — v1's handler fires only when the pre-phase base-merge already paused. Standing base-sync (a job that pre-merges base into feature branches outside phase boundaries) remains out of scope per #864's own Out-of-Scope note.
- **Multi-attempt agent resolution** — one autonomous attempt only, per #883 discipline. Multi-attempt / escalation-gate flow is a follow-up (analogous to #883's own follow-up posture).
- **Sibling-repo conflict resolution** — v1's FR-005 scope-guards against taking a sibling's file wholesale, but does not attempt cross-repo coordination (e.g., waiting for the sibling PR to merge before resolving). If the conflict *requires* a sibling PR to merge first, v1 stops with evidence.
- **Alternative merge strategies** (`ort`, `recursive` with rename-detection tuning, `-X ours`/`-X theirs`) — the handler uses git's default merge strategy; strategy tuning is a follow-up if empirically needed.
- **Auto-detection of `waiting-for:merge-conflicts` on issues that pre-date this handler's deployment** — the handler enqueues on new pause events (label-add), not on scanning existing issues. Operators clearing the historical backlog (like #6/#7/#8) use Ship 1's manual remedy for the first cycle after deploy.
- **Changing #864's pre-phase merge semantics** (ephemeral vs. committed, base ref resolution, phase coverage) — this spec builds on #864 as shipped; any change to that surface is out of scope.

---

*Generated by speckit*
