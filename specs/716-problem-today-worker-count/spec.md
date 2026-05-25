# Feature Specification: workers is per-host; CLI launch picks the count, cluster.local.yaml is the primary source

**Branch**: `716-problem-today-worker-count` | **Date**: 2026-05-25 | **Status**: Draft

## Summary

Move the worker count from a project-level shared value (`cluster.yaml`, committed to the repo) to a per-host value owned by `cluster.local.yaml`. The CLI `launch` command prompts (or accepts a flag) for the count at first run, writes it into the host's compose `.env` so the first `up` honors it, and passes a one-shot env var into the orchestrator container that seeds `.generacy/cluster.local.yaml` on first boot. After first boot, `cluster.local.yaml` becomes the single source of truth for this cluster's worker count — written by the entrypoint initially and by the orchestrator's worker-scaler on every subsequent scale operation. Legacy `workers: N` values in committed `cluster.yaml` continue to work via the existing local-wins shallow merge and migrate transparently on first scale.

## Problem

Today the worker count is treated as a project-level value: the cloud worker renders `workers: N` into `cluster.yaml` ([generacy-cloud#695](https://github.com/generacy-ai/generacy-cloud/issues/694)), and that file is committed into the user's repo. But the right number of workers depends on the **host's** capacity — CPU, RAM, disk — which varies per developer and per machine, not per project.

Generacy supports multiple developers running clusters under one project, and a single developer running multiple clusters under one project. A 16GB laptop and a 64GB workstation can't (and shouldn't) agree on a single `workers: N` value committed in shared source. The companion cloud issue ([generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696)) moves the value out of the rendered `cluster.yaml`. This issue covers the CLI / orchestrator side: where the value comes from at launch, and how the orchestrator reads it.

## What changes

### 1. CLI `launch` picks the worker count

The launch flow today hardcodes `workers: 1` in the scaffolder ([scaffolder.ts:75](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/scaffolder.ts#L75)). That becomes interactive (or flag-driven):

```bash
npx generacy launch --claim=<code>                 # prompt for workers
npx generacy launch --claim=<code> --workers=4     # non-interactive
```

The prompt should:
- Display the tier cap as the upper bound (fetched from launch-config — cloud already knows the org's tier).
- Show a default that's actually sensible — `min(tierCap, suggestedFromHost)`, where `suggestedFromHost` could start at a constant like 2 and refine later (see Out of Scope below for resource-aware defaults as a follow-up).
- Accept `--workers=N` for CI/non-interactive scripted launches; skip the prompt entirely when the flag is present.
- Reject `--workers` values > tier cap with a clear error referencing the tier upgrade path.

The chosen value writes to two places at scaffold time:
- Host's `~/Generacy/<project>/.generacy/.env` as `WORKER_COUNT=N` (so compose's `replicas: ${WORKER_COUNT:-1}` honors it on first `up`).
- An env var passed into the orchestrator container (e.g. `GENERACY_INITIAL_WORKERS=N` in the same compose `environment:` block) so the entrypoint can seed `cluster.local.yaml` on first boot.

### 2. Orchestrator seeds `cluster.local.yaml` on first boot

In [`entrypoint-orchestrator.sh`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/scripts/entrypoint-orchestrator.sh) (and the cluster-microservices sync), after `resolve-workspace.sh` clones the user repo: if `$WORKSPACE_DIR/.generacy/cluster.local.yaml` doesn't exist and `$GENERACY_INITIAL_WORKERS` is set, write a minimal file:

```yaml
workers: ${GENERACY_INITIAL_WORKERS}
```

Idempotent: only writes if the file doesn't exist. On subsequent boots, the file is already there (with whatever scaling operations have done to it since), and the env var is ignored.

This makes `cluster.local.yaml` the **first-class source** for the worker count on this cluster, written either by (a) the entrypoint at first boot from CLI choice, or (b) the orchestrator's worker-scaler on subsequent scale operations.

### 3. Orchestrator's merged-read prefers `cluster.local.yaml`

[`readMergedClusterConfig`](https://github.com/generacy-ai/generacy/blob/develop/packages/config/src/cluster-config.ts) already implements local-wins shallow merge. With `cluster.yaml` no longer containing `workers` (after companion cloud fix lands), the merged `workers` value comes from `cluster.local.yaml`. Nothing to change in the merge helper itself.

Legacy tolerance: `cluster.yaml` may still have a `workers` value on un-migrated projects. The merged read keeps using it as fallback (already does). On first scale operation, the worker-scaler writes `cluster.local.yaml: workers: N` and that takes precedence forever after — clean migration.

### 4. CLI `reconcileWorkerCount` (from [#708](https://github.com/generacy-ai/generacy/issues/708)/[#712](https://github.com/generacy-ai/generacy/issues/712))

Already uses `readMergedClusterConfig` (after #712) — picks up the new shape for free. No further changes needed on the up/update path.

### 5. Cloud relays the chosen value at activation time

Two questions for implementation, not blocking the design:

- Does the CLI need to *tell* the cloud which workers count was chosen at launch? Yes, so the cloud's cluster doc `targetWorkers` field (from [generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696)) starts in sync with reality. Implementation: include `workers` in the activation-complete payload the cluster sends to cloud, or in the cluster's metadata push (which #714 just made richer).
- Initial bootstrap UI flow: should the cloud's "Run on my computer" page also prompt for workers, then bake the value into the claim code / launch-config? Two paths exist (cloud-side or CLI-side prompt). I think CLI-side is cleaner — host knows itself best — but the cloud UI can pre-fill a non-binding default. Decide during clarify.

## Companion

[generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696) — stops the cloud worker from rendering `workers` into `cluster.yaml`, adds `targetWorkers` to the cluster doc, and moves the scaling UI to a per-cluster surface. The two issues are independent in landing order:

- This issue alone (without #696): CLI prompts, writes `cluster.local.yaml`, orchestrator reads it. `cluster.yaml` still has a stale `workers` field but local-wins makes it irrelevant.
- #696 alone (without this): cluster.yaml renders without `workers`, but the host `.env`'s `WORKER_COUNT` still defaults to 1 (CLI hasn't been updated to prompt). First-launch worker count is hardcoded, not user-chosen.

Both shipped together = the full new model.

## User Stories

### US1: Developer launches a cluster sized for their machine

**As a** developer running `npx generacy launch` on my own laptop or workstation,
**I want** the CLI to ask me how many workers to run (or accept a `--workers=N` flag),
**So that** I can pick a count that fits my host's CPU/RAM rather than inheriting a value from a teammate's repo or a project-wide default.

**Acceptance Criteria**:
- [ ] Interactive launch prompts me for a worker count, shows the org's tier cap as the upper bound, and offers a sensible default.
- [ ] `--workers=N` skips the prompt and uses `N` directly when running in CI or scripts.
- [ ] A value greater than the tier cap is rejected with a clear error message that references the tier upgrade path.
- [ ] The chosen value is written to my host's `.generacy/.env` as `WORKER_COUNT=N` and surfaces through compose's `replicas: ${WORKER_COUNT:-1}` on first `up`.

### US2: Two developers on the same project run different worker counts

**As a** teammate cloning the same Generacy project onto a smaller machine than the original developer,
**I want** my worker count to be independent of whatever count my colleague chose,
**So that** I don't overcommit my host because their committed `cluster.yaml` said `workers: 8`.

**Acceptance Criteria**:
- [ ] `cluster.local.yaml` is not committed to the repo and holds the per-host worker count.
- [ ] When `cluster.local.yaml` exists, its `workers` value wins over anything in `cluster.yaml` (shallow merge already does this).
- [ ] Two developers on the same project can run different worker counts on their respective hosts at the same time without conflict.

### US3: Orchestrator seeds the local file on first boot

**As the** orchestrator container starting up for the first time on a host,
**I want** to materialize `.generacy/cluster.local.yaml` with the worker count the CLI chose,
**So that** the cluster has a single source of truth for the worker count from boot onward, regardless of whether the committed `cluster.yaml` still has a stale `workers` field.

**Acceptance Criteria**:
- [ ] If `cluster.local.yaml` does not exist and `GENERACY_INITIAL_WORKERS` is set, the orchestrator entrypoint writes `workers: N` to `cluster.local.yaml` after the workspace clone completes.
- [ ] If `cluster.local.yaml` already exists, the entrypoint leaves it alone (idempotent on every subsequent boot).
- [ ] The seeding step runs in both `cluster-base` and `cluster-microservices` variants.

### US4: Legacy projects keep working and migrate transparently

**As a** developer with an existing project whose committed `cluster.yaml` still contains `workers: N`,
**I want** my cluster to keep behaving as before until I scale it,
**So that** the architectural change is invisible to me right up until the first scale operation, which transparently writes `cluster.local.yaml` and never reads from `cluster.yaml` again.

**Acceptance Criteria**:
- [ ] An un-migrated project with `workers: N` in `cluster.yaml` and no `cluster.local.yaml` continues to run with N workers.
- [ ] On the first scale operation, the worker-scaler writes the new value to `cluster.local.yaml` (not back into `cluster.yaml`).
- [ ] From that point forward, the merged read picks the local value via local-wins precedence.

### US5: Cloud cluster doc stays in sync with reality

**As an** operator looking at the cloud UI's cluster scaling tile,
**I want** the cloud's `targetWorkers` field to reflect the count actually chosen at launch,
**So that** I don't see a "Workers: 1" placeholder in the UI while my cluster is actually running with 4.

**Acceptance Criteria**:
- [ ] The CLI/orchestrator relays the chosen worker count to the cloud at activation or via the metadata push pipeline introduced in #714.
- [ ] The cloud's `targetWorkers` field on the cluster doc starts in sync with the value the CLI passed in.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `generacy launch` interactively prompts for worker count when `--workers` is not provided. | P1 | Use the existing `@clack/prompts` pattern used elsewhere in `launch`. |
| FR-002 | The launch prompt uses the org tier cap (from launch-config) as the upper bound and shows `min(tierCap, suggestedFromHost)` as the default. | P1 | `suggestedFromHost` may be a constant (e.g. 2) for v1; resource-aware default deferred. |
| FR-003 | `generacy launch --workers=N` skips the prompt and uses `N` directly. | P1 | For CI / scripted launches. |
| FR-004 | `--workers=N` greater than the org tier cap is rejected with a non-zero exit, error message, and reference to the tier upgrade path. | P1 | Same source-of-truth for the cap as the interactive prompt. |
| FR-005 | The CLI launch scaffolder writes `WORKER_COUNT=N` into the host's `.generacy/.env` file. | P1 | Replaces the hardcoded `WORKER_COUNT=1` at `scaffolder.ts:75`. |
| FR-006 | The CLI launch scaffolder emits a `GENERACY_INITIAL_WORKERS=N` env var in the orchestrator service's `environment:` block in the generated `docker-compose.yml`. | P1 | One-shot signal to the entrypoint; ignored after first boot. |
| FR-007 | The orchestrator entrypoint writes `workers: N` into `$WORKSPACE_DIR/.generacy/cluster.local.yaml` on first boot, only if the file does not exist and `GENERACY_INITIAL_WORKERS` is set. | P1 | Implemented in `entrypoint-orchestrator.sh` in `cluster-base`; synced to `cluster-microservices` via existing pattern. |
| FR-008 | The entrypoint seed step is idempotent — re-running on subsequent boots is a no-op when `cluster.local.yaml` already exists. | P1 | Must not overwrite values written by the worker-scaler. |
| FR-009 | The orchestrator's existing `readMergedClusterConfig` shallow-merge keeps treating `cluster.local.yaml` as local-wins over `cluster.yaml`. | P1 | No code change required; behavior must be preserved. |
| FR-010 | The CLI relays the chosen worker count to the cloud so that the cluster doc's `targetWorkers` field is initialized to match. | P2 | Mechanism (activation payload vs. metadata push) to be decided in clarify; depends on companion cloud issue. |
| FR-011 | Un-migrated projects with `workers: N` only in committed `cluster.yaml` continue to run with N workers until the first scale operation. | P1 | Existing fallback behavior in `readMergedClusterConfig`. |
| FR-012 | The first scale operation on a legacy project writes the new value to `cluster.local.yaml`, never back into `cluster.yaml`. | P1 | Already the worker-scaler's behavior; verify it holds for the new shape. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `generacy launch --claim=<code> --workers=4` on a tier with cap ≥ 4 results in 4 worker containers running and `cluster.local.yaml` containing `workers: 4`. | 100% on a fresh project. | Manual / e2e: run the launch, then `docker ps` and `cat .generacy/cluster.local.yaml`. |
| SC-002 | `generacy launch --claim=<code> --workers=999` on any tier exits non-zero with a tier-cap error. | 100% on a fresh project. | Manual / e2e. |
| SC-003 | Two simultaneous launches of the same project on two hosts produce two different `cluster.local.yaml` files and run different worker counts as chosen. | 100%. | Manual on two hosts, or scripted with two compose project names. |
| SC-004 | A second `generacy up` on the same host does not overwrite an existing `cluster.local.yaml`. | 100%. | Manual: launch with `--workers=4`, then re-run `generacy up`; confirm file unchanged. |
| SC-005 | Legacy projects with `workers: N` only in `cluster.yaml` continue to run with N workers until the first scale operation; after the first scale, `cluster.local.yaml` exists and wins. | 100%. | Manual / e2e: simulate a pre-migration project. |
| SC-006 | Cloud cluster doc's `targetWorkers` field equals the CLI-chosen value within one metadata push interval of activation. | ≤ 60s post-activation. | Inspect cluster doc in Firestore / cloud admin UI. |

## Assumptions

- The companion cloud issue ([generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696)) will be picked up and may ship before, after, or alongside this work; both orderings are explicitly designed to be safe.
- The launch-config payload from the cloud either already exposes the org's tier cap or will be extended to do so; this spec assumes the cap is available client-side at launch time.
- `cluster.local.yaml` is and remains gitignored — the worker-scaler and entrypoint never commit it.
- The orchestrator entrypoint runs after `resolve-workspace.sh` completes and has access to a writable `$WORKSPACE_DIR/.generacy/` directory.
- The cluster-microservices variant adopts the entrypoint change through the existing sync pattern between `cluster-base` and `cluster-microservices`; no separate logic is duplicated.

## Out of Scope

- **Resource-aware default suggestion**: `os.cpus()` / `os.totalmem()` → reasonable default proposal in the CLI prompt. Worth a follow-up issue but not a blocker for the architectural split — a constant default (e.g. 2) is fine for v1, the host owns the decision either way.
- **Bootstrap wizard UI on cloud side**: should there be a step in the bootstrap wizard for confirming/changing the workers count? Probably yes long-term but currently the +/- post-bootstrap is sufficient.
- **Cluster-microservices sync**: the entrypoint change is in cluster-base; cluster-microservices will sync via the existing pattern.
- **Per-worker liveness / `busy` / `idle` accounting**: tracked separately; not regressed by this work.

## Acceptance (from issue)

- `npx generacy launch --claim=<code>` prompts the user for a worker count, with the tier cap as the upper bound and a sensible default.
- `npx generacy launch --claim=<code> --workers=N` accepts the value non-interactively and rejects values exceeding tier cap with a clear error.
- The chosen value writes to host `.env` (`WORKER_COUNT=N`) and is passed to the orchestrator container (`GENERACY_INITIAL_WORKERS=N`).
- On first cluster boot, the orchestrator entrypoint creates `.generacy/cluster.local.yaml` with `workers: N` if absent.
- Existing projects with `workers: N` in committed `cluster.yaml` continue to work; first scale operation transparently migrates the value to `cluster.local.yaml` (no special migration step).
- Orchestrator's metadata payload reports the right worker count regardless of whether the value lives in `cluster.yaml` (legacy), `cluster.local.yaml` (new), or both (transition).

---

*Generated by speckit*
