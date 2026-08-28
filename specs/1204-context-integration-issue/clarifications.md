# Clarifications

## Batch 1 — 2026-08-28

### Q1: Deliverable shape of the implement phase
**Context**: This is a validation/reconciliation issue, not a feature build. The spec's FRs are dominated by *runs* (scaffold a cluster, deploy to staging, execute the dogfood recipe) that an in-repo worker agent cannot fully perform itself — cloud VM deploys and long-running cluster dogfoods need an operator or external environment. What the implement phase actually commits to this branch is therefore ambiguous: a runbook the operator executes, automation scripts that perform the runs, or a mix. This decides the entire task breakdown in `/plan` and `/tasks`.
**Question**: What artifacts should the implement phase produce in this repo?
**Options**:
- A: Runbook + results report — a step-by-step validation procedure in `specs/1204-.../` that the operator executes, plus a findings/diff report committed after runs complete; code changes only where a divergence is traced to this repo (scaffolder).
- B: Automation-first — committed scripts that scaffold the local cluster, drive the dogfood, collect worker/gateway logs, and perform the four-way stanza diff; the operator only runs the cloud leg manually.
- C: Agent-executed where possible — the agent itself scaffolds and runs the local cluster leg inside the workspace, documents outcomes, and hands the cloud leg to the operator via runbook.

**Answer**: *Pending*

### Q2: Dogfood workload identity
**Context**: FR-001/FR-003 say to "run the P2 mixed-route dogfood recipe (speckit-bugfix)" from #1203 on both clusters, but not what issue the recipe is run *against*. Reaching `completed:validate` (SC-001/SC-002) requires a real speckit-bugfix issue for the worker to drive. Whether each cluster run gets a fresh disposable issue, reuses #1203's original issue, or follows something the recipe itself prescribes changes setup steps, teardown, and how results are recorded.
**Question**: Which GitHub issue(s) do the mixed-route dogfood runs drive on the local and cloud clusters?
**Options**:
- A: Create a fresh disposable speckit-bugfix issue per cluster run (one for local, one for cloud), following the #1203 recipe's issue template.
- B: Re-run against the same issue #1203 used on the tetrad dev cluster, resetting its labels between runs.
- C: Whatever the #1203 recipe document prescribes — treat the recipe as authoritative and follow it verbatim, including issue creation.

**Answer**: *Pending*

### Q3: Canonical source in the four-way stanza reconciliation
**Context**: FR-005 diff-checks the gateway stanza across scaffolder output, tetrad dev compose, cluster-base compose, and the cloud-deploy template, and says discrepancies are "fixed in this repo or filed against the owning repo" — but not which source is *authoritative* when they genuinely differ. Without a declared canon, each diff becomes a judgment call about which side to change, and the same divergence could be "fixed" in opposite directions.
**Question**: When two sources diverge, which one is the reference the others must converge to?
**Options**:
- A: Tetrad dev compose — it is the validated hand-built environment the epic has been dogfooding against; all templates converge to it.
- B: The scaffolder output in this repo — going forward it is the published source of truth (CLAUDE.md already says scaffolder compose must mirror cluster-base), and dev/cloud mirrors converge to it.
- C: Case-by-case — no fixed canon; each diff is adjudicated on its merits and the reasoning recorded in the diff report.

**Answer**: *Pending*

### Q4: US4 scope — validate-only vs. fix-in-branch
**Context**: US4/FR-006 says `cockpit auto` must "correctly configure and dispatch agents whose model is a mixed set of gateway-route and subscription-route models", and the acceptance criterion allows "or the gap is filed". It is unclear whether code changes to cockpit in this branch are in scope if a gap is found, or whether this issue is strictly validation with all fixes deferred to follow-ups. This changes whether `/tasks` must budget for cockpit implementation work and a changeset.
**Question**: If `cockpit auto` mishandles mixed-route agent config, is fixing it in this branch in scope?
**Options**:
- A: Validation-only — any gap is filed as a follow-up issue with repro details; US4 is satisfied by the filing, and this branch stays code-light.
- B: Small fixes in scope — if the gap is contained to cockpit config plumbing in this repo, fix it here (with changeset); file only cross-repo or large gaps.
- C: Blocking — US4 must reach parity with the manual run within this issue, whatever it takes.

**Answer**: *Pending*

### Q5: Baseline for the log comparison (FR-002)
**Context**: FR-002 compares the scaffolded local cluster's worker logs and gateway access logs "against the tetrad dev run". It is unclear whether a preserved log artifact from the #1203 dev run exists to diff against, whether a fresh dev-cluster run must be executed side-by-side as the baseline, or whether the comparison is really a per-cluster route-discrimination check (gateway-route models appear in gateway access logs, subscription-route models do not) that needs no dev-run artifact at all.
**Question**: What serves as the comparison baseline for the scaffolded cluster's logs?
**Options**:
- A: Preserved artifacts from the #1203 dev run — diff against the recorded logs; no new dev run.
- B: A fresh tetrad dev-cluster run executed as part of this issue, giving a same-version side-by-side baseline.
- C: No log-artifact baseline — validate the route-discrimination *criteria* independently on each cluster (gateway models hit the gateway log, subscription models are absent); "matches the dev run" means "satisfies the same criteria".

**Answer**: *Pending*
