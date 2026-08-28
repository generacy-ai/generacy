# Feature Specification: P3 Integration — Gateway-Enabled Local & Cloud Clusters Run the Mixed-Route Dogfood

**Branch**: `1204-context-integration-issue` | **Date**: 2026-08-28 | **Status**: Draft
**Epic**: generacy-ai/generacy#1197 (LLM gateway model routing) | **Phase**: P3 (integration)

## Summary

Close out P3 of the LLM gateway model routing epic by proving that the gateway
configuration — already shipped as isolated contracts — actually works end-to-end on
**published** cluster templates (not the tetrad dev cluster). This is a validation and
reconciliation issue: scaffold a fresh local cluster with `--llm-gateway`, deploy a cloud
cluster with `llmGatewayEnabled=true`, run the P2 mixed-route dogfood recipe on both,
diff-check the gateway compose stanza across all four template sources, and record the
outcome as "P3 complete" in the design doc. Any divergence or failure is either fixed here
or filed against the owning repo.

## Context

Integration issue closing P3 (generalize the gateway wiring to the launcher + published
cluster templates). Upstream contracts that this issue validates are already merged or
in-flight:

- Scaffolder `--llm-gateway` service + `.env` provisioning — generacy-ai/generacy#1202
- cluster-base `setup-claude-gateway-config.sh` port + entrypoint — generacy-ai/cluster-base#90
- generacy-cloud compose-template mirror (`llmGatewayEnabled`) — generacy-ai/generacy-cloud#919
- P2 dogfood recipe (mixed-route speckit-bugfix) — generacy-ai/generacy#1203

P1 route-resolution and launch plumbing (#1198–#1201) is merged: a model string containing
`/` (`provider/model-name`) resolves to the **gateway route** and receives the gateway
config dir at launch; all other model strings (`claude-opus`, `claude-sonnet`, …) resolve to
the **subscription route**. "Mixed-route" means a single dogfood run exercises both routes so
the session-drop, routing, and logging behaviour is validated across the boundary. Full
design: `docs/llm-gateway-model-routing-plan.md` in generacy-ai/tetrad-development.

## Clarifications

### Session 2026-08-28 (Batch 1, answered via issue comment)

- Q1 → **A**: The implement phase produces a **runbook + results report** in
  `specs/1204-.../` that the operator executes; code changes only where a divergence is
  traced to this repo (the scaffolder). No throwaway orchestration machinery; the four-way
  stanza diff may be a small committed helper, but the deliverable is procedure + findings.
- Q2 → **A**: Each cluster run drives a **fresh disposable speckit-bugfix issue** (one
  local, one cloud) per the #1203 recipe's template. The mixed-route `orchestrator.agents`
  block must be committed and pushed on the target repo's working branch (per-repo agent
  overrides load from the target repo's checkout). Gateway model selection: filter by
  `context_length` first — 32k-context models (e.g. featherless Qwen3-Coder variants) pass
  smoke tests but cannot open the files a real run needs.
- Q3 → **A**: The **tetrad dev compose is canon** for the four-way reconciliation
  (`.devcontainer/generacy/docker-compose.yml:180-218`); templates converge to it. A
  divergence is presumptively a port bug; deliberate template adaptations (token
  generation, env plumbing) are recorded in the diff report as intentional.
- Q4 → **A**: US4 is **validation-only**. The mixed-route cockpit fix is owned by P4
  (agency#510) and lives in the agency repo; this issue records the observed behavior of
  today's `cockpit auto` playbook against a mixed `cockpit.auto.agents` block and appends
  repro details to #510 (or files fresh if the failure differs).
- Q5 → **C**: **No log-artifact baseline** for FR-002. Route-discrimination criteria are
  validated independently on each cluster (gateway-route models appear in the gateway
  access log, subscription-route models are absent, zero gateway error lines); "matches
  the dev run" means "satisfies the same criteria". #1203's recorded metrics remain a
  qualitative sanity reference.

## User Stories

### US1: Operator scaffolds a gateway-enabled local cluster and it just works

**As a** Generacy operator using published packages and the cluster-base image,
**I want** `generacy launch --llm-gateway` (or the equivalent flag) to scaffold a cluster
whose gateway service, `.env`, and config script match the validated tetrad dev cluster,
**So that** gateway model routing behaves identically outside the hand-built dev environment.

**Acceptance Criteria**:
- [ ] A fresh local cluster scaffolded with `--llm-gateway` starts the gateway service and reaches `completed:validate` on the mixed-route dogfood recipe.
- [ ] Worker logs and gateway access logs from the scaffolded cluster satisfy the route-discrimination criteria from the #1203 dev run (gateway-route models hit the gateway; subscription-route models do not; zero gateway error lines) — criteria-based, no log-artifact diff (Q5).

### US2: Operator deploys a gateway-enabled cloud cluster and it just works

**As a** Generacy operator deploying to a staging cloud VM,
**I want** a cluster deployed with `llmGatewayEnabled=true` and a provider key in `.env.local` to run the same recipe successfully,
**So that** the cloud-deploy template is proven equivalent to the local and dev templates.

**Acceptance Criteria**:
- [ ] A staging cloud cluster with `llmGatewayEnabled=true` reaches `completed:validate` on the mixed-route dogfood recipe.
- [ ] Any divergence from the local/dev behaviour is filed against generacy-ai/generacy-cloud.

### US3: The gateway stanza is identical across all four template sources

**As a** maintainer of the cluster templates,
**I want** the gateway compose stanza reconciled across scaffolder output, tetrad dev compose, cluster-base compose, and the cloud-deploy template,
**So that** freshly provisioned clusters never silently diverge from the dev cluster.

**Acceptance Criteria**:
- [ ] The gateway service/env stanza is diff-checked across all four sources; discrepancies are either fixed in this repo or filed against the owning repo with the diff attached.

### US4: cockpit auto handles mixed-route agent config

**As an** operator driving issues through `cockpit auto`,
**I want** cockpit auto to correctly configure and dispatch agents whose model is a mixed set of gateway-route and subscription-route models,
**So that** the automated path exercises the gateway exactly as the manual dogfood does.

**Acceptance Criteria**:
- [ ] A `cockpit auto` run over the dogfood issue(s) provisions the gateway agent config and reaches the same terminal state as the manual run (or the gap is filed).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scaffold a fresh local cluster with `--llm-gateway` using published packages + cluster-base image (not tetrad dev), and run the P2 mixed-route dogfood recipe (speckit-bugfix). | P1 | Validates #1202 + #90 |
| FR-002 | Validate the scaffolded local cluster's worker logs and gateway access logs against the #1203 route-discrimination criteria; attribute any divergence. | P1 | Criteria-based per Q5; no log-artifact baseline |
| FR-003 | Deploy a staging cloud cluster with `llmGatewayEnabled=true`, provider key in `.env.local` on the VM, and run the same recipe. | P1 | Validates #919 |
| FR-004 | File divergences of the cloud run against generacy-ai/generacy-cloud. | P1 | |
| FR-005 | Diff-check the gateway stanza across scaffolder output, tetrad dev compose, cluster-base compose, and cloud-deploy template; fix in-repo or file against the owning repo. | P1 | Four-way reconciliation; tetrad dev compose is canon (Q3) |
| FR-006 | Validate `cockpit auto` correctly configures mixed-route agent config on the dogfood run. | P2 | Validation-only; gaps recorded against agency#510 (Q4) |
| FR-007 | Update `docs/llm-gateway-model-routing-plan.md` (tetrad-development) status to "P3 complete" with findings. | P2 | Design doc lives in another repo |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Local scaffolded cluster dogfood outcome | Reaches `completed:validate` | Cockpit/worker terminal state on the dogfood issue |
| SC-002 | Cloud staging cluster dogfood outcome | Reaches `completed:validate` | Cockpit/worker terminal state on the dogfood issue |
| SC-003 | Gateway route correctness | Gateway-route models hit the gateway; subscription-route models bypass it | Gateway access logs vs. worker logs on both clusters |
| SC-004 | Template stanza parity | Zero unexplained diffs across the four sources | Recorded diff-check; each diff fixed or filed |
| SC-005 | Failures accounted for | 100% of failures attributed and filed | Linked issues for every non-`completed:validate` outcome |

## Assumptions

- The upstream contracts (#1202, #90, #919, #1203) are merged/available when this integration runs; if a contract is missing, this issue blocks on it rather than re-implementing it.
- A staging cloud environment and a valid provider API key are available for the cloud run.
- The mixed-route dogfood recipe from #1203 is the canonical validation workload; each cluster run drives a fresh disposable speckit-bugfix issue per its template (Q2).
- The implement phase delivers a runbook + results report; runs are executed by the operator, not the in-repo worker (Q1).
- "Failures are attributed and filed" satisfies acceptance even if a run does not reach `completed:validate`, provided root cause is identified and tracked.

## Out of Scope

- Building or changing the gateway routing logic itself (P1, already merged).
- Authoring the scaffolder flag, cluster-base script, or cloud template (the upstream contract issues own those).
- Production (non-staging) cloud deployment.
- Provider/gateway capacity, cost, or rate-limit tuning.

---

*Generated by speckit*
