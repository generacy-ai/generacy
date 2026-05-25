# Feature Specification: ## Problem

Today the worker count is treated as a project-level value: the cloud worker renders \`workers: N\` into \`cluster

**Branch**: `716-problem-today-worker-count` | **Date**: 2026-05-25 | **Status**: Draft

## Summary

## Problem

Today the worker count is treated as a project-level value: the cloud worker renders \`workers: N\` into \`cluster.yaml\` ([generacy-cloud#695](https://github.com/generacy-ai/generacy-cloud/issues/694)), and that file is committed into the user's repo. But the right number of workers depends on the **host's** capacity — CPU, RAM, disk — which varies per developer and per machine, not per project.

Generacy supports multiple developers running clusters under one project, and a single developer running multiple clusters under one project. A 16GB laptop and a 64GB workstation can't (and shouldn't) agree on a single \`workers: N\` value committed in shared source. The companion cloud issue ([generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696)) moves the value out of the rendered \`cluster.yaml\`. This issue covers the CLI / orchestrator side: where the value comes from at launch, and how the orchestrator reads it.

## What changes

### 1. CLI \`launch\` picks the worker count

The launch flow today hardcodes \`workers: 1\` in the scaffolder ([scaffolder.ts:75](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/scaffolder.ts#L75)). That becomes interactive (or flag-driven):

\`\`\`bash
npx generacy launch --claim=<code>                 # prompt for workers
npx generacy launch --claim=<code> --workers=4     # non-interactive
\`\`\`

The prompt should:
- Display the tier cap as the upper bound (fetched from launch-config — cloud already knows the org's tier).
- Show a default that's actually sensible — \`min(tierCap, suggestedFromHost)\`, where \`suggestedFromHost\` could start at a constant like 2 and refine later (see Out of Scope below for resource-aware defaults as a follow-up).
- Accept \`--workers=N\` for CI/non-interactive scripted launches; skip the prompt entirely when the flag is present.
- Reject \`--workers\` values > tier cap with a clear error referencing the tier upgrade path.

The chosen value writes to two places at scaffold time:
- Host's \`~/Generacy/<project>/.generacy/.env\` as \`WORKER_COUNT=N\` (so compose's \`replicas: \${WORKER_COUNT:-1}\` honors it on first \`up\`).
- An env var passed into the orchestrator container (e.g. \`GENERACY_INITIAL_WORKERS=N\` in the same compose \`environment:\` block) so the entrypoint can seed \`cluster.local.yaml\` on first boot.

### 2. Orchestrator seeds \`cluster.local.yaml\` on first boot

In [\`entrypoint-orchestrator.sh\`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/entrypoint-orchestrator.sh) (and the cluster-microservices sync), after \`resolve-workspace.sh\` clones the user repo: if \`\$WORKSPACE_DIR/.generacy/cluster.local.yaml\` doesn't exist and \`\$GENERACY_INITIAL_WORKERS\` is set, write a minimal file:

\`\`\`yaml
workers: \${GENERACY_INITIAL_WORKERS}
\`\`\`

Idempotent: only writes if the file doesn't exist. On subsequent boots, the file is already there (with whatever scaling operations have done to it since), and the env var is ignored.

This makes \`cluster.local.yaml\` the **first-class source** for the worker count on this cluster, written either by (a) the entrypoint at first boot from CLI choice, or (b) the orchestrator's worker-scaler on subsequent scale operations.

### 3. Orchestrator's merged-read prefers \`cluster.local.yaml\`

[\`readMergedClusterConfig\`](https://github.com/generacy-ai/generacy/blob/develop/packages/config/src/cluster-config.ts) already implements local-wins shallow merge. With \`cluster.yaml\` no longer containing \`workers\` (after companion cloud fix lands), the merged \`workers\` value comes from \`cluster.local.yaml\`. Nothing to change in the merge helper itself.

Legacy tolerance: \`cluster.yaml\` may still have a \`workers\` value on un-migrated projects. The merged read keeps using it as fallback (already does). On first scale operation, the worker-scaler writes \`cluster.local.yaml: workers: N\` and that takes precedence forever after — clean migration.

### 4. CLI \`reconcileWorkerCount\` (from [#708](https://github.com/generacy-ai/generacy/issues/708)/[#712](https://github.com/generacy-ai/generacy/issues/712))

Already uses \`readMergedClusterConfig\` (after #712) — picks up the new shape for free. No further changes needed on the up/update path.

### 5. Cloud relays the chosen value at activation time

Two questions for implementation, not blocking the design:

- Does the CLI need to *tell* the cloud which workers count was chosen at launch? Yes, so the cloud's cluster doc \`targetWorkers\` field (from [generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696)) starts in sync with reality. Implementation: include \`workers\` in the activation-complete payload the cluster sends to cloud, or in the cluster's metadata push (which #714 just made richer).
- Initial bootstrap UI flow: should the cloud's \"Run on my computer\" page also prompt for workers, then bake the value into the claim code / launch-config? Two paths exist (cloud-side or CLI-side prompt). I think CLI-side is cleaner — host knows itself best — but the cloud UI can pre-fill a non-binding default. Decide during clarify.

## Out of scope

- **Resource-aware default suggestion**: \`os.cpus()\` / \`os.totalmem()\` → reasonable default proposal in the CLI prompt. Worth a follow-up issue but not a blocker for the architectural split — a constant default (e.g. 2) is fine for v1, the host owns the decision either way.
- **Bootstrap wizard UI on cloud side**: should there be a step in the bootstrap wizard for confirming/changing the workers count? Probably yes long-term but currently the +/- post-bootstrap is sufficient.
- **Cluster-microservices sync**: the entrypoint change is in cluster-base; cluster-microservices will sync via the existing pattern.

## Companion

[generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696) — stops the cloud worker from rendering \`workers\` into \`cluster.yaml\`, adds \`targetWorkers\` to the cluster doc, and moves the scaling UI to a per-cluster surface. The two issues are independent in landing order:

- This issue alone (without #696): CLI prompts, writes \`cluster.local.yaml\`, orchestrator reads it. \`cluster.yaml\` still has a stale \`workers\` field but local-wins makes it irrelevant.
- #696 alone (without this): cluster.yaml renders without \`workers\`, but the host \`.env\`'s \`WORKER_COUNT\` still defaults to 1 (CLI hasn't been updated to prompt). First-launch worker count is hardcoded, not user-chosen.

Both shipped together = the full new model.

## Acceptance

- \`npx generacy launch --claim=<code>\` prompts the user for a worker count, with the tier cap as the upper bound and a sensible default.
- \`npx generacy launch --claim=<code> --workers=N\` accepts the value non-interactively and rejects values exceeding tier cap with a clear error.
- The chosen value writes to host \`.env\` (\`WORKER_COUNT=N\`) and is passed to the orchestrator container (\`GENERACY_INITIAL_WORKERS=N\`).
- On first cluster boot, the orchestrator entrypoint creates \`.generacy/cluster.local.yaml\` with \`workers: N\` if absent.
- Existing projects with \`workers: N\` in committed \`cluster.yaml\` continue to work; first scale operation transparently migrates the value to \`cluster.local.yaml\` (no special migration step).
- Orchestrator's metadata payload reports the right worker count regardless of whether the value lives in \`cluster.yaml\` (legacy), \`cluster.local.yaml\` (new), or both (transition).

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
