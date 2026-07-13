# Implementation Plan: Merge base into feature branch before implement / pre-validate / validate

**Feature**: Pre-phase base merge (guardrail against vacuous-green validate + stale-tree implement) — #864
**Branch**: `864-found-during-cockpit-v1`
**Status**: Complete

## Summary

Nothing in the pipeline ever merges `origin/<base>` into the feature branch before a phase runs code. Staleness and conflicts surface only at PR merge time — after review and validate have already passed against a tree that will not exist post-merge (christrudelpw/sniplink#3 was the observed incident: implement wrote a Prisma-only `package.json` against a stale tree because the sibling scaffold PR wasn't merged yet, and validate went green on `npm error Missing script: "test"` because the branch tree standalone was structurally not a buildable app).

The fix has three moving parts:

1. **Base-merge hook at phase start** for `implement`, `pre-validate`, and `validate`. Reset to branch tip → fetch `origin/<base>` → `git merge origin/<base>`. Ephemeral for pre-validate/validate; committed & pushed for implement (rides out with implement's normal push).
2. **New pause gate** `waiting-for:merge-conflicts` / `completed:merge-conflicts` for merge-conflict pauses, distinguishable in `cockpit status` output. Evidence block enumerates the conflicted paths (distinguishable from "validate command failed" mode).
3. **Warning-only queue check**: `cockpit queue <ref> implement` reads plan.md, extracts declared cross-issue dependencies, and warns when a listed prerequisite isn't yet closed/merged. Not a hard block in v1.

Base ref resolves from the open PR's `baseRefName` via `gh pr view`, falling back to the repo default branch when no PR exists yet.

## Technical Context

**Language / runtime**: TypeScript, Node.js ≥22, ESM.
**Repos touched**: `packages/orchestrator/src/worker/`, `packages/generacy/src/cli/commands/cockpit/` (and their `__tests__/`).
**External calls**: `git` CLI (already available in worker containers via existing `execFileAsync('git', ...)` usage in `repo-checkout.ts`); `gh pr view --json baseRefName` (already used by `PrManager` / `product-diff.ts`).
**Direct dependencies (new)**: none. Everything is a new function/module that reuses existing subprocess wrappers.
**Existing dependencies leaned on**:
- `RepoCheckout` (`packages/orchestrator/src/worker/repo-checkout.ts`) — already resets and fetches; extend with a base-merge method.
- `PhaseLoop` (`packages/orchestrator/src/worker/phase-loop.ts`) — extend the pre-phase branch (currently only pre-validate install) to run a base-merge for implement / pre-validate / validate.
- `LabelManager` / `GateChecker` / `WorkerConfigSchema` — add the new `waiting-for:merge-conflicts` gate label + condition.
- `StageCommentData.errorEvidence` — extend with a merge-conflict discriminant so `stage-comment-manager.ts` renders conflicted paths distinctly (per FR-010).
- `resolveIssueContext` / `resolveEpic` — already used by `cockpit queue`. Read `specs/<ref>/plan.md` for dependency mentions.

**Constraints**:
- Ephemeral pre-validate/validate merges MUST NOT be pushed (FR-006).
- Implement-time merge IS pushed as a distinct commit ahead of implement's own commits (FR-013). Squash-merge at PR close collapses it.
- Reset-at-start is the crash-safety story (Q3→A): every phase begins with `git reset --hard origin/<branch>`; nothing persists across phase boundaries.
- Warning-only for the plan.md dependency check in v1 (FR-009, Q5-scope).
- Bounded conflict-resolution subagent is Out of Scope (Q4→B); v1 pauses via the standard label protocol.

## Project Structure

```
packages/orchestrator/src/worker/
├── base-merge.ts                          NEW — pure git primitives + orchestration
│   ├── resolveBaseBranch(github, prManager, checkoutPath, owner, repo, logger)
│   ├── performBaseMerge(checkoutPath, branch, baseRef, logger, opts)  # opts.commit: boolean
│   └── types: BaseMergeResult = { ok: true, baseRef, mergeSha?: string }
│                             | { ok: false, baseRef, conflictedPaths: string[] }
├── repo-checkout.ts                       MODIFY
│   └── + fetchBase(checkoutPath, baseBranch)          # `git fetch origin <base>`
│   └── + resetToBranchTip(checkoutPath, branch)       # `git reset --hard origin/<branch>` (extracted from switchBranch)
├── phase-loop.ts                          MODIFY
│   └── injects BaseMergeRunner dep; runs performBaseMerge before implement / pre-validate / validate
│   └── on conflict: applies waiting-for:merge-conflicts label + errorEvidence.mergeConflict payload + pause return
├── stage-comment-manager.ts               MODIFY
│   └── renderStageComment: when errorEvidence.mergeConflict set, render "Merge conflict" heading + conflicted-paths list
├── types.ts                               MODIFY
│   └── StageCommentData.errorEvidence gains optional { mergeConflict?: { baseRef, conflictedPaths } } discriminant
├── config.ts                              MODIFY
│   └── Default gates for speckit-feature / speckit-bugfix add:
│       [{ phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' }]
│   └── GateDefinitionSchema.condition enum gains 'on-merge-conflict'
├── gate-checker.ts                        MODIFY (light — gate is triggered directly from phase-loop on merge conflict)
└── __tests__/
    ├── base-merge.test.ts                 NEW — unit tests for the pure git primitives (mock execFile)
    ├── base-merge-phase-loop.test.ts      NEW — phase-loop integration: clean/conflict/no-PR paths
    ├── merge-conflict-evidence-block.test.ts  NEW — stage-comment renderer smoke test for the new evidence shape
    └── phase-loop.merge.test.ts           NEW — implement / pre-validate / validate hook ordering + push-vs-ephemeral discriminant

packages/generacy/src/cli/commands/cockpit/
├── queue.ts                               MODIFY
│   └── After resolveIssueContext + resolveEpic, for phase === 'implement':
│       for each ref: fetch plan.md via `gh api` → extractPlanDependencies → check merged state → attach to QueueRow.warnings
│   └── renderPreview: additional [WARN: depends-on <ref> not yet merged] lines beneath eligible rows
├── plan-dependency-extractor.ts           NEW — pure function
│   └── extractPlanDependencies(planMarkdown: string): DependencyRef[]
│       # v1 heuristic: match "#<N>" and "<owner>/<repo>#<N>" mentions in the "must be merged first"
│       # / "depends-on" / "extends" / "requires" line neighborhood. Documented in research.md.
└── __tests__/
    └── plan-dependency-extractor.test.ts  NEW — table-driven positive + negative cases

specs/864-found-during-cockpit-v1/
├── spec.md                                (existing, read-only)
├── clarifications.md                      (existing, read-only)
├── plan.md                                THIS FILE
├── research.md                            NEW
├── data-model.md                          NEW
├── contracts/
│   ├── base-merge-runner.md               NEW — internal contract for base-merge.ts
│   ├── merge-conflict-evidence-block.md   NEW — evidence-block shape extension (companions #847's contract)
│   ├── merge-conflict-gate-label.md       NEW — label naming + gate flow
│   └── plan-dependency-warning.md         NEW — queue-time warning schema + rendering
└── quickstart.md                          NEW
```

## Phase Ordering Inside `PhaseLoop.executeLoop`

For each iteration (renumbered from `phase-loop.ts` step numbers):

1. Existing steps 1–2 (label update + stage comment).
2. **NEW** — pre-phase base-merge for `implement`, and (later, inside the `phase === 'validate'` branch) before pre-validate install AND before validate command:
   - resolve base branch (FR-011)
   - `resetToBranchTip(checkoutPath, branch)` + `fetchBase(checkoutPath, baseBranch)`
   - `performBaseMerge(...)` with `commit=true` for implement, `commit=false` for pre-validate/validate
   - On `BaseMergeResult.ok=false`: build `errorEvidence.mergeConflict`, call `labelManager.onGateHit(phase, 'waiting-for:merge-conflicts')`, update stage comment (status `in_progress` — this is a pause, not an error), return `gateHit: true`. Reuses the existing gate-return path so `#849` paired-clear applies symmetrically.
3. Existing steps 3–8.

The reset+fetch+merge sequence is crash-safe (Q3→A). A worker killed mid-merge leaves nothing behind because the next phase entry re-resets first.

## Constitution Check

There is no `.specify/memory/constitution.md` in this repo (verified). Nothing to check against.

## Verification

- Unit: `base-merge.test.ts` for the git primitives, `plan-dependency-extractor.test.ts` for the queue heuristic.
- Integration: `phase-loop.merge.test.ts` covers clean, conflict, no-PR-base fallback, ephemeral-vs-committed discriminant, and pause-return contract.
- Manual: replay a known-conflicting branch (christrudelpw/sniplink#3 pre-repair state) locally against a modified worker; confirm the evidence block names `package.json`, `CLAUDE.md`, `package-lock.json`.
- SC-002 target ("PR pages carrying add/add or content conflicts at review") is exercised by running the merge-conflict integration test with a fixture that reproduces `main`'s add/add conflict topology.
- SC-004 target ("cockpit surfaces merge-conflict pauses as a distinct state") is exercised by rendering the stage comment on a merge-conflict pause and asserting the "Merge conflict" heading string is present.

## Out of Scope (from spec — deferred to follow-up issues)

- Bounded conflict-resolution subagent (former FR-008; Q4→B) — v1 pauses only.
- Standing / webhook-driven base-sync — v1 syncs only at phase start.
- Hard-blocking `cockpit queue` on unmerged dependency — v1 warns only.
- Formalized `depends-on:` schema in plan.md — v1 heuristic-only.
- Multi-base branches — one base per feature branch in v1.
- Retroactive validation of already-merged PRs.

---

*Generated by speckit*
