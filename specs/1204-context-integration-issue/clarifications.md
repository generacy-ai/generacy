# Clarifications

## Batch 1 — 2026-08-28

### Q1: Deliverable shape of the implement phase
**Context**: This is a validation/reconciliation issue, not a feature build. The spec's FRs are dominated by *runs* (scaffold a cluster, deploy to staging, execute the dogfood recipe) that an in-repo worker agent cannot fully perform itself — cloud VM deploys and long-running cluster dogfoods need an operator or external environment. What the implement phase actually commits to this branch is therefore ambiguous: a runbook the operator executes, automation scripts that perform the runs, or a mix. This decides the entire task breakdown in `/plan` and `/tasks`.
**Question**: What artifacts should the implement phase produce in this repo?
**Options**:
- A: Runbook + results report — a step-by-step validation procedure in `specs/1204-.../` that the operator executes, plus a findings/diff report committed after runs complete; code changes only where a divergence is traced to this repo (scaffolder).
- B: Automation-first — committed scripts that scaffold the local cluster, drive the dogfood, collect worker/gateway logs, and perform the four-way stanza diff; the operator only runs the cloud leg manually.
- C: Agent-executed where possible — the agent itself scaffolds and runs the local cluster leg inside the workspace, documents outcomes, and hands the cloud leg to the operator via runbook.

**Answer**: A — Runbook + results report. A step-by-step validation procedure in `specs/1204-.../` that the operator executes, plus a findings/diff report committed after the runs complete; code changes only where a divergence is traced to this repo (the scaffolder). P3's phasing says the templates "port a proven implementation instead of iterating", and every FR is a *run* an in-repo worker cannot perform — scaffolding needs published packages plus the cluster-base image, and the cloud leg needs a staging VM with `.env.local` provider keys. B would invent throwaway orchestration machinery contrary to the port-don't-invent principle; C overstates what a worker container can execute (cannot bring up a sibling docker-compose cluster or reach staging). The four-way stanza diff may be a trivial committed helper, but the deliverable is the procedure plus the findings report. *(Answered via GitHub by @christrudelpw)*

### Q2: Dogfood workload identity
**Context**: FR-001/FR-003 say to "run the P2 mixed-route dogfood recipe (speckit-bugfix)" from #1203 on both clusters, but not what issue the recipe is run *against*. Reaching `completed:validate` (SC-001/SC-002) requires a real speckit-bugfix issue for the worker to drive. Whether each cluster run gets a fresh disposable issue, reuses #1203's original issue, or follows something the recipe itself prescribes changes setup steps, teardown, and how results are recorded.
**Question**: Which GitHub issue(s) do the mixed-route dogfood runs drive on the local and cloud clusters?
**Options**:
- A: Create a fresh disposable speckit-bugfix issue per cluster run (one for local, one for cloud), following the #1203 recipe's issue template.
- B: Re-run against the same issue #1203 used on the tetrad dev cluster, resetting its labels between runs.
- C: Whatever the #1203 recipe document prescribes — treat the recipe as authoritative and follow it verbatim, including issue creation.

**Answer**: A — Create a fresh disposable speckit-bugfix issue per cluster run (one for local, one for cloud), following the #1203 recipe's issue template. There is no standalone recipe document, so C is hollow — #1203's "recipe" is its body plus results comment, and it ran against #1211, which is now consumed. B would reset a real issue's history and collide with the one-active-cluster-per-repo constraint while the tetrad cluster still monitors generacy. A fresh disposable issue also satisfies the #1203 finding that per-repo agent overrides load from the target repo's committed checkout (`claude-cli-worker.ts:751` → `tryLoadOrchestratorSettings`): the mixed-route `orchestrator.agents` block must be committed and pushed on that repo's working branch — safe on a disposable target, pollution on generacy `develop`. Selection constraint: pick the gateway model by `context_length` first — every Qwen3-Coder variant on featherless caps at 32,768 tokens while `phase-loop.ts` alone is ~35k, so a 32k model passes a smoke test and then cannot open the files the run needs. *(Answered via GitHub by @christrudelpw)*

### Q3: Canonical source in the four-way stanza reconciliation
**Context**: FR-005 diff-checks the gateway stanza across scaffolder output, tetrad dev compose, cluster-base compose, and the cloud-deploy template, and says discrepancies are "fixed in this repo or filed against the owning repo" — but not which source is *authoritative* when they genuinely differ. Without a declared canon, each diff becomes a judgment call about which side to change, and the same divergence could be "fixed" in opposite directions.
**Question**: When two sources diverge, which one is the reference the others must converge to?
**Options**:
- A: Tetrad dev compose — it is the validated hand-built environment the epic has been dogfooding against; all templates converge to it.
- B: The scaffolder output in this repo — going forward it is the published source of truth (CLAUDE.md already says scaffolder compose must mirror cluster-base), and dev/cloud mirrors converge to it.
- C: Case-by-case — no fixed canon; each diff is adjudicated on its merits and the reasoning recorded in the diff report.

**Answer**: A — Tetrad dev compose is canon; all templates converge to it for this reconciliation. The plan doc designates the tetrad dev cluster as the reference implementation cluster-base later ports, and states that P3 ports the P2 findings so "the scaffolder and cloud-deploy templates must not rediscover them". The hard-won behaviors — the `sk-bf-` token prefix, the named `/app/data` volume, no `source_of_truth`, `list_models: false`, the tracked token-free `config.json` — live in the tetrad stanza (`.devcontainer/generacy/docker-compose.yml:180-218`), so at P3 a divergence is presumptively a port bug. Deliberate template adaptations (token generation, env plumbing) are recorded in the diff report as intentional rather than "fixed". B becomes true only after this reconciliation makes the scaffolder a faithful superset; C reintroduces exactly the drift the plan calls a known hazard. *(Answered via GitHub by @christrudelpw)*

### Q4: US4 scope — validate-only vs. fix-in-branch
**Context**: US4/FR-006 says `cockpit auto` must "correctly configure and dispatch agents whose model is a mixed set of gateway-route and subscription-route models", and the acceptance criterion allows "or the gap is filed". It is unclear whether code changes to cockpit in this branch are in scope if a gap is found, or whether this issue is strictly validation with all fixes deferred to follow-ups. This changes whether `/tasks` must budget for cockpit implementation work and a changeset.
**Question**: If `cockpit auto` mishandles mixed-route agent config, is fixing it in this branch in scope?
**Options**:
- A: Validation-only — any gap is filed as a follow-up issue with repro details; US4 is satisfied by the filing, and this branch stays code-light.
- B: Small fixes in scope — if the gap is contained to cockpit config plumbing in this repo, fix it here (with changeset); file only cross-repo or large gaps.
- C: Blocking — US4 must reach parity with the manual run within this issue, whatever it takes.

**Answer**: A — Validation-only. Any gap is filed as a follow-up issue with repro details; US4 is satisfied by the filing, and this branch stays code-light. The fix is already specified and owned by P4: agency#510 defines exactly this handling (omit cross-route subagent models with one pre-flight warning; the cockpit loader exposes route per role), and the code lives in agency's `packages/claude-plugin-cockpit/commands/auto.md` and `packages/cockpit/src/config/loader.ts` — not in this generacy branch — so B's "contained to this repo" premise cannot hold, and C would drag a cross-repo P4 deliverable into a P3 validation issue. What P3 owes US4 is the observed behavior of today's playbook against a mixed `cockpit.auto.agents` block (`auto.md:262` passes configured models straight to Agent spawns with no route awareness), with repro details appended to #510 or filed fresh if the failure differs from what #510 predicts. *(Answered via GitHub by @christrudelpw)*

### Q5: Baseline for the log comparison (FR-002)
**Context**: FR-002 compares the scaffolded local cluster's worker logs and gateway access logs "against the tetrad dev run". It is unclear whether a preserved log artifact from the #1203 dev run exists to diff against, whether a fresh dev-cluster run must be executed side-by-side as the baseline, or whether the comparison is really a per-cluster route-discrimination check (gateway-route models appear in gateway access logs, subscription-route models do not) that needs no dev-run artifact at all.
**Question**: What serves as the comparison baseline for the scaffolded cluster's logs?
**Options**:
- A: Preserved artifacts from the #1203 dev run — diff against the recorded logs; no new dev run.
- B: A fresh tetrad dev-cluster run executed as part of this issue, giving a same-version side-by-side baseline.
- C: No log-artifact baseline — validate the route-discrimination *criteria* independently on each cluster (gateway models hit the gateway log, subscription models are absent); "matches the dev run" means "satisfies the same criteria".

**Answer**: C — No log-artifact baseline. Validate the route-discrimination criteria independently on each cluster; "matches the dev run" means "satisfies the same criteria". The #1203 evidence is criteria-shaped, not artifact-shaped — its pass condition was exactly one launch on the featherless model and four on `claude-fable-5`, gateway phases present in the Bifrost access log, subscription phases absent, zero gateway error lines. The raw gateway logs live in Bifrost's `logs.db` with `log_retention_days: 7`, so no durable artifact exists to byte-diff against and A is not available. B burns a full extra dev-cluster run — colliding with the serial one-cluster-per-repo constraint — purely to manufacture a baseline the criteria already encode. The metrics recorded on #1203 (10 requests, 5.3–11.5s latency, 0 errors) stay as a qualitative sanity reference in the report. *(Answered via GitHub by @christrudelpw)*
