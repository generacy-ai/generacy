# Clarifications: #864

Sequential clarification questions and answers for spec.md. New questions append; answers replace `*Pending*`.

## Batch 1 — 2026-07-08

### Q1: Gate label naming
**Context**: FR-005 explicitly flags this as TBD: the pause on ephemeral-merge conflict needs a gate label that `cockpit status`/`cockpit watch` can render distinctly (SC-004: "100% of conflict pauses" surfaced as a distinct state). The choice affects both the worker (which label it applies) and the cockpit rendering path (whether a new label needs to be recognized).
**Question**: Which gate label should the worker apply when an ephemeral base-merge conflicts?
**Options**:
- A: New label `waiting-for:merge-conflicts` (paired with `completed:merge-conflicts`, per the existing pause/resume protocol). Distinct in cockpit output by name.
- B: Reuse an existing pause label (e.g. `waiting-for:validate` or `waiting-for:human`) with the conflict state distinguished only by the #847 evidence block body.
- C: New label `waiting-for:base-sync` — names the cause (base-sync failure) rather than the symptom (merge conflicts).

**Answer**: *Pending*

### Q2: Base branch resolution
**Context**: FR-001/002/007 all say "fetch `origin/<base>`" and Assumptions says "well-defined base branch resolvable at phase start (typically `main` or `develop`)" — but the spec never says *how* the worker resolves `<base>`. Different sources (PR base, workspace config, repo default branch) can disagree, and pre-validate may run before any PR exists.
**Question**: Where does the worker read the base branch name from at phase start?
**Options**:
- A: The open PR's `baseRefName` (via `gh pr view` on the branch). Falls back to repo default branch if no PR exists yet.
- B: The workspace-level config (`.agency/config.yaml` or the workflow definition), with the repo default branch as fallback.
- C: The repo's default branch, unconditionally (whatever `origin/HEAD` points at).
- D: An issue-level or plan.md-declared override, falling back to the PR base.

**Answer**: *Pending*

### Q3: Ephemeral merge state between phases
**Context**: FR-006 says the merge is "workspace-local and never pushed" and FR-001/002 apply it before pre-validate *and* before validate. If pre-validate merged, left the merge staged (or committed locally), and validate runs later, the workspace state carried into validate is ambiguous. Also: a phase that follows validate (review, merge) shouldn't start from a merge-contaminated tree.
**Question**: How is the ephemeral merge cleaned up between phases?
**Options**:
- A: Each phase does a fresh reset to the branch tip (`git reset --hard origin/<branch>`), then re-fetches base and re-merges. Nothing persists across phase boundaries.
- B: The merge is left in place after the phase runs; the next phase inherits it. Cleanup only on worker shutdown / branch switch.
- C: The merge is aborted (`git merge --abort` or discard the working tree) as soon as the phase's validate/pre-validate command exits, regardless of outcome. Next phase re-does its own merge.

**Answer**: *Pending*

### Q4: FR-008 subagent scope for v1
**Context**: FR-008 (bounded conflict-resolution subagent, proposal (b)) is listed with priority P2 and "MAY be invoked" — but the FR is still in the v1 requirements table, not in "Out of Scope". The Out of Scope section only excludes the *push* form of proposal (b), not the subagent itself. Whether this ships in v1 changes the implementation surface substantially (need to wire an agent invocation into the pause path).
**Question**: Is the bounded conflict-resolution subagent (FR-008) in scope for v1?
**Options**:
- A: In scope for v1. On conflict, invoke the subagent first; only pause via FR-005 if the subagent cannot resolve. Bounded shape mirrors the cockpit merge fixer.
- B: Out of scope for v1. On conflict, go directly to the pause protocol (FR-005). The subagent is a follow-up issue. FR-008 moves to "Out of Scope".
- C: In scope but feature-flagged / opt-in per repo. Default off in v1; enabling it is per-repo config.

**Answer**: *Pending*

### Q5: Implement phase coverage
**Context**: The observed incident was caused by the *implement* phase working on a stale tree (implement agent didn't see the sibling scaffold because base hadn't been merged in). But US1/FR-001/FR-002 only cover pre-validate and validate — implement is not listed. Proposal (b) explicitly mentions "at phase start (implement, validate)". If implement is excluded, v1 catches the vacuous-green symptom but does not prevent the root cause (implement writing wrong code from a stale tree). If included, the ephemeral merge changes what implement sees but complicates commit hygiene (the merge would need to be resolved before implement commits, or implement's commit would carry base's tree).
**Question**: Should the ephemeral base-merge also run at the start of the implement phase?
**Options**:
- A: Yes — merge base into workspace before implement runs, same as pre-validate/validate. Implement sees the post-merge tree; commit hygiene handled by committing the merge as a distinct commit before implement's own commits.
- B: No — v1 covers only pre-validate and validate as spec'd. Implement still runs on the stale branch tip; the guardrail catches the resulting break at validate. Implement coverage is a follow-up.
- C: Yes, but the merge is committed onto the feature branch and pushed at implement start (this is proposal (b) at the implement phase, not proposal (a)). Redefines v1 scope — out of Out-of-Scope's "push-based base-sync" exclusion.

**Answer**: *Pending*
