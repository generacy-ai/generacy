# Clarifications for #1049

## Batch 1 — 2026-07-26

### Q1: Fix approach
**Context**: The issue body's *Proposed fix* section lists three distinct options. FR-001 declares the exact evidence-set an implementation choice, but the choice is load-bearing: Option 1 (sticky `agent:*` while a PR is open) forces a `cockpit_advance` behaviour change (Out of Scope carve-out); Options 2 and 3 do not. Deferring to the implementer means the `cockpit_advance` scope is undecided at plan time.
**Question**: Which fix approach should the implementer take?
**Options**:
- A: Keep the last `agent:*` label sticky while an unmerged PR is open on the issue (issue Option 1) — implies a `cockpit_advance` change so it stops stripping `agent:paused`
- B: Widen the orchestrated test to accept `workflow:*` and/or `completed:*` (issue Option 2) — no `cockpit_advance` change needed
- C: Accept ANY speckit label (`agent:*`, `phase:*`, `completed:*`, `workflow:*`) (issue Option 3) — no `cockpit_advance` change needed
- D: Implementer picks freely within FR-001 / FR-002 bounds, including a hybrid

**Answer**: *Pending*

### Q2: Merged PRs
**Context**: The spec is silent on reviews posted after a PR is merged. Reviewers routinely leave inline comments post-merge to file follow-up work. The current `agent:*`-only guard already accepts them (as long as the label is present); a widened guard would too. But the operator may want an explicit gate here.
**Question**: When a reviewer posts a review on a **merged** PR whose linked issue carries widened evidence, should the fixer still enqueue?
**Options**:
- A: Yes — treat merged the same as open for the widened guard (existing behaviour, extended by the widening)
- B: No — skip merged PRs with a new gate (log at `info` per FR-004)
- C: Out of scope — leave whatever happens today as-is; do not add a merged-PR gate in this spec

**Answer**: *Pending*

### Q3: Wrong-cluster gate log level in shared repos
**Context**: FR-004 lifts all four post-`Processing PR review event from poll` gates to `info` when the PR has an unresolved review thread. In a multi-cluster shared repo (e.g., generacy + generacy-cloud + agency all pointing at one org), the "wrong-cluster assignee" gate fires on **every poll** for every PR belonging to another cluster — that is expected, not a bug. Lifting it to `info` will produce a steady stream of expected-noise `info` lines.
**Question**: Should the wrong-cluster gate stay at `debug` (expected noise), or lift to `info` as FR-004 currently states?
**Options**:
- A: Lift all four gates including wrong-cluster — as FR-004 states literally
- B: Keep wrong-cluster at `debug`; lift only the other three (no-link / assignees-empty / not-orchestrated) — revise FR-004
- C: Lift wrong-cluster to `info` only when NO cluster in the repo owns the PR (no assignee matches any known `CLUSTER_GITHUB_USERNAME`) — hybrid

**Answer**: *Pending*

### Q4: `phase:*` alone as orchestration evidence
**Context**: US2's negative acceptance criterion says the guard rejects when NONE of `agent:*` / `phase:*` / `completed:*` / `workflow:*` is present. It does NOT say the guard must ACCEPT when ANY is present — leaving the positive condition ambiguous. An issue with only `phase:specify` (partially-run, workflow assigned but engine dropped it before writing `workflow:*`) is the ambiguous case.
**Question**: Does the presence of ONLY `phase:*` labels (no `completed:*`, `workflow:*`, or `agent:*`) count as sufficient orchestration evidence for the widened guard?
**Options**:
- A: Yes — any of the four label prefixes counts (symmetric with US2's negative)
- B: No — require `workflow:*` or `completed:*` (rejects incomplete/failed runs that never got past specify)
- C: Only `workflow:*` counts as durable evidence (strictest — survives advance, survives completion, survives failure)

**Answer**: *Pending*
