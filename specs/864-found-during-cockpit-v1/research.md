# Research: Pre-Phase Base Merge (#864)

## Decision: reset-at-start, not abort-at-exit

**Choice**: Every phase entry begins with `git reset --hard origin/<branch>` + fresh fetch of base + fresh merge attempt (per FR-012 / Q3→A).

**Alternatives considered**:
- (B) Leave merge in place after phase runs; next phase inherits it. Rejected: fragile across worker restarts and phase-boundary crashes; ambiguous state carried into validate.
- (C) Abort merge (`git merge --abort`) at phase exit regardless of outcome. Rejected: dies with the worker (SIGKILL doesn't run cleanup), so a killed worker leaves a poisoned tree for the next entry.

**Rationale**: Reset-at-start is idempotent and crash-safe. Workspaces are disposable (`RepoCheckout` already treats them as ephemeral: `switchBranch` and `updateRepo` both `git reset --hard HEAD` + `git clean -fd` before doing anything). Legitimate work is protected because phases push their commits before the next phase runs.

**Reference**: `packages/orchestrator/src/worker/repo-checkout.ts` lines 102–125 (existing reset-then-fetch pattern in `switchBranch`).

## Decision: base ref from PR, fallback to `origin/HEAD`

**Choice**: Resolve `<base>` from `gh pr view --json baseRefName` on the open PR; fall back to repo default branch when no PR exists yet (per FR-011 / Q2→A).

**Alternatives considered**:
- (B) Workspace-level config (`.agency/config.yaml` or workflow definition) with default-branch fallback. Rejected: a config nobody writes is just a default that has to be right anyway (the #847 lesson).
- (C) Repo default branch unconditionally. Rejected: silently wrong for retargeted / stacked PRs.
- (D) Issue-level or plan.md-declared override. Rejected: manifest complexity for no observed need.

**Rationale**: The PR base is authoritative — it's what CI checks out for `refs/pull/N/merge` and what the merge button will use. It also handles the retargeted/stacked-PR case correctly for free.

**Implementation**: Reuse `product-diff.ts:resolveBaseRef` shape (already does exactly this for the product-diff check). Extract to a shared helper so `phase-loop.ts` and `base-merge.ts` both call it.

**Reference**: `packages/orchestrator/src/worker/product-diff.ts:41–54` — existing `resolveBaseRef(github, prManager, owner, repo)` that already does PR-base-with-default-fallback. Extend it (or hoist to shared) rather than duplicate.

## Decision: implement-phase merge is a real commit, not ephemeral

**Choice**: For the implement phase, the base-merge is committed onto the feature branch and pushed with implement's normal push (per FR-013 / Q5→A). For pre-validate and validate phases, it is ephemeral (never pushed) per FR-006.

**Alternatives considered**:
- (B) v1 covers pre-validate and validate only; implement still runs on the stale tip. Rejected: catches the vacuous-green symptom only, not the root cause. Implement writing wrong code from a stale tree was the observed damage (#864 originating incident).
- (C) Merge is pushed but as a standing sync job outside phase boundaries. Rejected — that's the excluded "webhook-driven base-sync" from Out of Scope.

**Rationale**: If implement doesn't see the post-merge tree, it writes code against the wrong world. The manual repair of sniplink#3 confirms: `package.json` was minimal Prisma-only precisely because the scaffold sibling hadn't been merged in. The merge commit is ordinary branch hygiene — collapsed to nothing by the squash-merge at PR close.

## Decision: `on-merge-conflict` as a distinct gate condition

**Choice**: Add `'on-merge-conflict'` to `GateDefinitionSchema.condition` enum. The gate is triggered directly by `PhaseLoop` from the `performBaseMerge` conflict branch, not by `gateChecker.checkGates`. The condition value in `WorkerConfig.gates` documents intent (and lets us feature-flag off in tests) but the trigger is imperative.

**Alternatives considered**:
- Reuse `'always'` and drive the gate purely by whether the conflict is present. Rejected: the gate wouldn't be visible in the workflow config's declared gate set unless someone reads the phase-loop code.
- Skip the enum entirely and treat the pause as a special code path. Rejected: symmetry with `waiting-for:sibling-review` (#692) — same pattern of "gate active only when a runtime condition holds", declared in config for documentation.

**Rationale**: Matches the `on-sibling-review` precedent (#692). The `condition` enum names the trigger cause; the code path evaluates it. `cockpit status` already renders `waiting-for:*` labels distinctly, satisfying SC-004 without additional cockpit changes.

**Reference**: `packages/orchestrator/src/worker/config.ts:14` (`GateDefinitionSchema.condition`), `packages/orchestrator/src/worker/phase-loop.ts:479–495` (`on-sibling-review` runtime evaluation).

## Decision: merge-conflict evidence-block extension, not new block

**Choice**: Extend `StageCommentData.errorEvidence` with an optional `mergeConflict?: { baseRef: string; conflictedPaths: string[] }` discriminant. When set, `stage-comment-manager.ts:renderStageComment` renders a "Merge conflict" heading + conflicted-paths list instead of the `command`/`exitDescriptor`/`stderrTail` block.

**Alternatives considered**:
- New top-level `StageCommentData.mergeConflictEvidence`. Rejected: doubles the surface area for one variant; renderer has to check both fields.
- Reuse `errorEvidence.stderrTail` to jam in the conflicted paths. Rejected: FR-010 explicitly says they must be distinguishable at a glance.

**Rationale**: Discriminated union inside the existing block keeps the schema tight, the renderer branches once, and the #847 contract stays intact for the non-conflict path.

**Reference**: `specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md`, `packages/orchestrator/src/worker/stage-comment-manager.ts:170–199`.

## Decision: plan.md dependency extraction is a regex heuristic in v1

**Choice**: For FR-009, the extractor scans the plan.md body for `#<N>` and `<owner>/<repo>#<N>` mentions in the neighborhood of dependency-signalling verbs: `must be merged first`, `extends`, `depends-on`, `requires`, `blocked by`. Warning-only.

**Alternatives considered**:
- Structured `depends-on:` frontmatter field. Rejected explicitly by spec Assumptions ("the schema is not formalized in v1").
- LLM-extracted. Rejected: latency + cost + non-determinism at queue time, for a warning-only signal.
- Nothing (skip FR-009 entirely). Rejected: proposal (c) is explicitly in scope for v1.

**Rationale**: The christrudelpw/sniplink#3 case wrote "#2 must be merged first" verbatim in plan.md — a regex catches that. False positives are cheap (warning-only, operator can proceed). False negatives are the same failure mode as today (no worse). Structured schema is a follow-up.

**Extractor sketch**:
```
Match on a line containing any of the trigger verbs, extract all
`#<digits>` and `<[\w-]+/[\w-]+>#<digits>` from that line and the two
lines following it. De-duplicate. Cross-repo refs resolve to
{owner, repo, number}; bare `#<N>` resolves to the current repo.
```

## Non-decision: proposal (b) — bounded conflict-resolution subagent

Explicitly Out of Scope per Q4→B. Followed up in a separate issue. Noted here so the follow-up is discoverable.

## Sources / references

- Observed incident: christrudelpw/sniplink#3, PR #15/16.
- `specs/847-found-during-cockpit-v1/` — evidence-block contract (companion).
- `specs/849-*/` — paired resume-dedupe clear (pairs symmetrically with the new gate).
- `specs/692-*/` — `on-sibling-review` runtime condition precedent.
- Git behavior: `git merge --no-ff origin/<base>` in a dirty tree — dirty-tree case cannot happen because we reset first (FR-012).
