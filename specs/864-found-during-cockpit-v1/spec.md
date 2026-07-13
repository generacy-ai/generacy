# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #28

**Branch**: `864-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #28.

**Nothing in the pipeline ever merges the base branch into a feature branch.** Not at implement start, not before validate, not when the base moves. Staleness and conflicts surface only at merge time — after review and validate have already passed against a tree that will not exist post-merge.

## Observed

christrudelpw/sniplink#3 (branch `003-phase-1-foundation-part`) was cut before sibling scaffold #2 (PR #16) merged to main — even though #3's own plan.md says "#2 must be merged first" and "issue #3 extends scaffold #2's package.json". The implement agent, working on the stale tree, wrote a minimal Prisma-only `package.json` instead of extending the scaffold. Consequences:

1. **validate failed structurally, not incidentally**: `npm test` → `npm error Missing script: "test"` (exit 1 in 118 ms). The branch tree standalone is not a buildable app and never can be — no re-run fixes it. (The #847 evidence block rendered this correctly.)
2. **PR #15 carries add/add conflicts** with main in `CLAUDE.md`, `package.json`, `package-lock.json`, plus duplicate-entry hunks in `.gitignore` — all discovered only by a human looking at the PR page.
3. Even if validate had passed on the branch tip, it would have validated a tree that differs from the post-merge result — vacuous green, same class as #857.

## Proposal (layered, weakest to strongest)

**(a) Validate the merge preview, not the branch tip.** Before pre-validate/validate, the worker merges `origin/<base>` into the workspace (ephemeral, never pushed). Clean merge → validate now tests the real post-merge tree — exactly what CI systems do by checking out `refs/pull/N/merge`. Conflict → fail loud, listing the conflicted paths in the #847 evidence block. Cheap, no new writes to the repo, catches both staleness and conflicts at the earliest phase that runs code.

**(b) Base-sync with agent conflict resolution.** At defined trigger points, merge base into the feature branch and push. On conflict, invoke the agent CLI with a bounded conflict-resolution task — the same shape as the cockpit merge fixer subagent, but upstream, where it prevents the red instead of reacting to it. If the agent cannot resolve, pause with the standard protocol (`waiting-for:merge-conflicts` or similar) so cockpit watch/status surface it as actionable. Trigger point options:
   - at phase start (implement, validate) — bounded frequency, syncs exactly when the tree is about to be used; **recommended starting point**
   - on base-branch push (webhook/poll) — freshest, but churns long-lived branches and burns agent invocations on branches nobody is about to touch

**(c) Dependency-aware sequencing (v2).** The plan already encodes "#2 must be merged first"; the queue ignores it. Even a warning at queue time ("this issue's plan declares a dependency on #2, which is not yet merged") would have flagged this before implement ran.

(a) is the guardrail, (b) is the remedy, (c) is the prevention. (a) alone would have turned this from "validate green-lights a broken tree / human discovers conflicts on the PR page" into a loud early failure naming the three conflicted files.

## Manual repair applied on the test project

Merged main into `003-phase-1-foundation-part` (commit `9c5be5a`): `package.json` union (scaffold scripts/deps + Prisma additions), `CLAUDE.md` graft (scaffold doc + persistence section), `package-lock.json` regenerated via `npm install` against the merged manifest, `.gitignore` deduplicated. Verified `npm test && npm run build` green in-container before push; re-armed the resume label pair and cleared the phase-tracker dedupe key so validate re-runs.


## User Stories

### US1: Validate runs against the post-merge tree, not the branch tip

**As an** orchestrator worker running the implement, pre-validate, and validate phases,
**I want** the workspace to reflect `origin/<base>` merged into the feature branch before I run any phase commands,
**So that** the phase operates on the real post-merge tree — the same guarantee CI gets by checking out `refs/pull/N/merge` instead of the branch tip, and implement never writes code against a stale tree that will not exist post-merge (the #864 originating condition).

**Acceptance Criteria**:
- [ ] Before the implement, pre-validate, and validate phases execute their commands, the worker resets to the branch tip, freshly fetches `origin/<base>`, and performs a `git merge origin/<base>` into the workspace.
- [ ] The validate-time and pre-validate-time ephemeral merges are never pushed to the remote — they exist only in the worker's checkout.
- [ ] The implement-time merge is committed as a distinct merge commit ahead of implement's own commits and rides out with implement's normal push (ordinary branch hygiene; the squash-merge at PR close collapses it).
- [ ] A clean merge lets the phase proceed against the merged tree.
- [ ] A conflicting merge aborts the phase, emits the conflicted paths into the #847 evidence block, and applies the standard pause label.
- [ ] Base ref is `origin/<base>`, freshly fetched — not a stale local ref.

### US2: Merge-conflict pauses land as actionable work, not silent stalls

**As an** operator watching cockpit,
**I want** an ephemeral merge that produces conflicts to surface as a distinct, actionable state (e.g. `waiting-for:merge-conflicts` or the equivalent gate label),
**So that** `cockpit status`/`cockpit watch` shows the issue as blocked-on-conflicts rather than as a mystery validate failure, and a bounded conflict-resolution subagent (per proposal (b)) can be invoked upstream instead of the cockpit merge fixer having to react to red checks at merge time.

**Acceptance Criteria**:
- [ ] When the ephemeral merge fails, the phase pauses via the existing pause/resume-label protocol.
- [ ] `cockpit status` reports the conflict state with the list of conflicted paths.
- [ ] The pause gate is symmetric with existing gates (paired resume-dedupe clear, per #849, applies).

### US3: Queue-time warning when plan.md declares a dependency on an unmerged issue

**As an** operator queueing a speckit-feature issue for implement,
**I want** cockpit to warn me when the issue's plan.md names another issue as a prerequisite and that prerequisite is not yet merged,
**So that** we don't cut branches on trees that were never going to include the sibling scaffold (the #864 originating scenario — cut #3 while #2 was still in review).

**Acceptance Criteria**:
- [ ] `cockpit queue <ref> implement` reads plan.md, looks for declared dependencies on other issues, and surfaces a warning when any listed issue is not yet closed/merged.
- [ ] The warning is a warning (not a hard block) in v1 — the operator can still proceed. Hard-blocking is deferred to v2.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Before the pre-validate phase runs, the worker fetches `origin/<base>` and attempts `git merge --no-ff --no-commit origin/<base>` into the workspace. | P1 | Proposal (a). Ephemeral — never pushed. |
| FR-002 | Before the validate phase runs, the worker fetches `origin/<base>` and attempts the same ephemeral merge. | P1 | Proposal (a). Redundant with FR-001 by design — base may have moved between phases. |
| FR-003 | If the ephemeral merge is clean, the phase proceeds against the merged tree. | P1 | |
| FR-004 | If the ephemeral merge produces conflicts, the phase fails loud: conflicted paths are enumerated in the #847 evidence block. | P1 | Structural failure, distinct from command-exit-nonzero failure. |
| FR-005 | On merge conflict, the phase pauses via the existing pause/resume-label protocol using the gate label `waiting-for:merge-conflicts` (paired resume label `completed:merge-conflicts`, per Q1 clarification). | P1 | Pairs with #849's paired-clear. |
| FR-006 | The pre-validate and validate ephemeral merges are workspace-local and never pushed to the remote branch. The implement-phase merge (FR-013) is committed and pushed as a distinct merge commit ahead of implement's own commits — ordinary branch hygiene, collapsed by the squash-merge at PR close. | P1 | Clarified per Q5: "never pushed" applies to validate-time only. |
| FR-007 | The ephemeral merge uses a freshly fetched `origin/<base>` — worker must fetch before merging, not rely on a stale local ref. | P1 | |
| FR-008 | *(removed per Q4 clarification — bounded conflict-resolution subagent moved to Out of Scope for v1)* | — | See Out of Scope. |
| FR-009 | `cockpit queue <ref> implement` MUST parse the target issue's plan.md, extract declared dependencies on other issues, and emit a warning when any dependency is not yet merged/closed. | P3 | Proposal (c). Warning-only in v1; hard-block deferred. |
| FR-010 | The evidence block (#847) MUST distinguish "merge conflict" failure mode from "validate command failed" failure mode — operators need to tell them apart at a glance. | P1 | |
| FR-011 | The worker resolves `<base>` from the open PR's `baseRefName` (via `gh pr view` on the branch); if no PR exists yet, it falls back to the repo default branch (`origin/HEAD`). | P1 | Q2 clarification. Authoritative even for deliberately retargeted / stacked PRs. |
| FR-012 | Each phase entry begins with `git reset --hard origin/<branch>` followed by a fresh fetch of `origin/<base>` and a fresh merge attempt. Nothing persists across phase boundaries; a worker killed mid-merge leaves no contaminated state for the next phase. | P1 | Q3 clarification. Reset-at-start is crash-safe; workspaces are disposable. |
| FR-013 | Before the implement phase runs, the worker performs the same reset+fetch+merge as pre-validate/validate. On a clean merge, the merge commit is committed to the feature branch as a distinct commit ahead of implement's own commits (rides out with implement's normal push per FR-006). On conflict, FR-004/FR-005 apply. | P1 | Q5 clarification. Prevents implement writing wrong code from a stale tree (root cause of #864). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Vacuous-green validate runs (branch tip green, post-merge tree would be red) reaching the review phase. | 0 | Instrument: for a sample of merged PRs, replay the pre-merge branch tip against the pre-merge base and confirm validate would have caught the delta. |
| SC-002 | PR pages carrying add/add or content conflicts with `main` at the time of human review. | 0 | Every conflict is surfaced during pre-validate/validate as a loud failure, not by a reviewer opening the PR page. |
| SC-003 | Time from base-branch update to detection of induced conflict on an active feature branch. | Within 1 phase invocation | The next pre-validate/validate on the affected branch names the conflicting files. |
| SC-004 | Cockpit surfaces merge-conflict pauses as a distinct state. | 100% of conflict pauses | `cockpit status` output distinguishes merge-conflict pause from other `waiting-for:*` pauses. |

## Assumptions

- The base branch is resolvable at phase start via FR-011: the open PR's `baseRefName` (authoritative for retargeted/stacked PRs), falling back to the repo default branch (`origin/HEAD`) when no PR exists yet. Multi-base scenarios are out of scope for v1.
- The worker has write access to its workspace (for FR-012's `git reset --hard` and the ephemeral merge) and, for the implement phase, push access to the feature branch (for FR-013's merge commit). No push to `<base>` itself in any phase.
- The `plan.md` dependency-declaration format for FR-009 (proposal (c)) is a natural-language artifact the queue command can regex or LLM-extract from; the schema is not formalized in v1.
- The #847 evidence block already has a slot suitable for enumerating conflicted paths, or one can be added without a schema-migration on stored evidence.

## Out of Scope

- **Bounded conflict-resolution subagent (former FR-008)** — per Q4 clarification. On ephemeral-merge conflict, v1 goes directly to the pause protocol (FR-005); the reactive remedy already exists (cockpit merge's fixer subagent plus human resolution via the new gate). The upstream conflict-resolution subagent is a follow-up issue.
- **Standing / webhook-driven base-sync** — proposal (b)'s "on base-branch push" trigger point (a job running outside phase boundaries). v1 syncs only at phase start. Note: FR-013's implement-phase merge commit *is* pushed with implement's normal push, but that is not a standing sync job — the Out-of-Scope exclusion applies to base-sync workers that run outside the phase envelope.
- **Hard-blocking queue on unmerged dependency** — proposal (c) is warning-only in v1.
- **Formalizing `plan.md` dependency schema** — v1 extracts what's already there; a structured `depends-on:` field is a follow-up.
- **Multi-base branches** — one base branch per feature branch.
- **Retroactive validation of already-merged PRs** — v1 changes the pipeline going forward; back-fill is not attempted.

---

*Generated by speckit*
