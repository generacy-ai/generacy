# Feature Specification: Local Cluster Identity Alignment with Cloud Cluster-Doc ID

**Branch**: `750-summary-local-cluster-s` | **Date**: 2026-06-04 | **Status**: Draft
**Issue**: [#750](https://github.com/generacy-ai/generacy/issues/750)
**Type**: Bug fix

## Summary

A **local cluster's runtime identity (`GENERACY_CLUSTER_ID`) does not match its cloud cluster-doc id.** The cluster relays/authenticates as the cloud doc id (via that doc's API key) but self-identifies as a *different* UUID for tunnel-name derivation, orchestrator identity, and worker enumeration — an identity split.

The `generacy deploy` command already correctly adopts the cloud-returned `cluster_id` (see `cli/commands/deploy/activation.ts:85` and `cli/commands/deploy/scaffolder.ts:33`). The local launch path scaffolds with a locally-minted or pre-existing id and never reconciles it with the cloud-minted doc id. This fix brings the local launch path in line with the deploy path.

## Evidence (observed on staging)

Project `Xr7fxq61PF57U2lOtoKe`, local cluster `todo-list-example1-local-1`:
- Orchestrator process env: **`GENERACY_CLUSTER_ID=6c23c4c4-97d6-44ad-ac7a-b2302e9d7e9a`**
- Cloud cluster-doc id (and relay identity): **`a356d8f5-cca3-4f4a-9070-4fd8084b0468`**
  - Firestore doc `organizations/vnVZ…/clusters/a356d8f5-…` exists (`name: todo-list-example1-local-1`, `mode: local`), with one `api_keys/*`.
  - Relay log: `[relay] coexist: cluster=a356d8f5-… joining project=Xr7fxq61PF57U2lOtoKe`
- No doc exists under `clusters/6c23c4c4-…` (404), and it has no `api_keys` — so this is an **identity split, not a duplicate doc**.

## User Stories

### US1: Operator debugging a local cluster sees one identity

**As a** Generacy operator/developer investigating a misbehaving local cluster,
**I want** the cluster's runtime `GENERACY_CLUSTER_ID` to match the cloud cluster-doc id,
**So that** I can correlate logs, tunnel names, relay traffic, and Firestore docs by a single identifier without cross-referencing two UUIDs.

**Acceptance Criteria**:
- [ ] When inspecting a local cluster's orchestrator env, the `GENERACY_CLUSTER_ID` value matches the id used as the Firestore cluster-doc key.
- [ ] The tunnel name registered with Microsoft (`g-<prefix>`) is derived from the same id present in the cloud doc.
- [ ] Relay handshake logs (`cluster=<id>`) and orchestrator env id are identical.

### US2: New local cluster scaffolds with cloud-minted id

**As a** user running the web "Add cluster → local" flow (which invokes the launch command),
**I want** the launch path to adopt the cloud-returned `cluster_id`,
**So that** my freshly-created local cluster has a single, canonical identity from the moment it boots.

**Acceptance Criteria**:
- [ ] After `generacy launch` completes, `.generacy/cluster.json` contains `cluster_id` equal to the cloud-minted id.
- [ ] The `docker-compose.yml` (or `.env`) sets `GENERACY_CLUSTER_ID` to the same id.
- [ ] No locally-generated UUID is persisted that does not correspond to a cloud cluster doc.

### US3: Worker enumeration and assignee filtering work end-to-end on local clusters

**As a** developer relying on per-cluster features (orchestrator assignee filtering #742, worker enumeration, per-cluster reporting),
**I want** the local cluster's self-reported identity to match the doc id those features key on,
**So that** these features work correctly on local clusters, not just `deploy`-provisioned remote clusters.

**Acceptance Criteria**:
- [ ] Assignee filtering by cluster id (#742) succeeds on local clusters.
- [ ] Any feature querying Firestore by `clusters/<GENERACY_CLUSTER_ID>` resolves correctly.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The local launch path MUST persist the cloud-returned `cluster_id` (not a locally-minted UUID) into `.generacy/cluster.json`. | P1 | Mirrors deploy: `cli/commands/deploy/activation.ts:85`, `cli/commands/deploy/scaffolder.ts:33`. |
| FR-002 | The generated `docker-compose.yml` and/or `.env` MUST export `GENERACY_CLUSTER_ID` set to the cloud-returned `cluster_id`. | P1 | Consumed by orchestrator, tunnel-name derivation, relay metadata. |
| FR-003 | The cloud-returned `cluster_id` MUST be the single source of truth for the local launch path — no shadow/orphan id may be minted client-side. | P1 | Prevents identity split. |
| FR-004 | If the web "Add cluster → local" flow pre-creates a cluster doc, that doc's id MUST be fed into the launch command (e.g. via claim code → `LaunchConfig.clusterId`). | P1 | Verify cloud `buildLaunchConfig` returns the doc id. |
| FR-005 | Existing local clusters with mismatched ids MUST NOT be silently rewritten. Reconciliation/migration is out of scope for this fix. | P2 | Fresh clusters only. |
| FR-006 | The fix MUST NOT regress the `generacy deploy` path, which already adopts the cloud-returned id correctly. | P1 | Regression check. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Identity match on fresh local cluster | 100% | After `generacy launch`, `GENERACY_CLUSTER_ID` from orchestrator env equals Firestore cluster-doc id. |
| SC-002 | No orphan ids | 0 | No client-minted UUIDs exist that lack a corresponding cloud cluster doc. |
| SC-003 | Tunnel-name source id matches doc id | 100% | `deriveTunnelName(GENERACY_CLUSTER_ID)` uses the same id keying the cluster doc. |
| SC-004 | Deploy path regression | 0 regressions | `generacy deploy` continues to scaffold with cloud-returned id (unchanged behavior). |

## Assumptions

- The cloud-side `buildLaunchConfig` (or equivalent) already returns the canonical `cluster_id` from the cloud cluster doc — or can be made to do so as part of this fix.
- The web "Add cluster → local" flow that pre-creates the cluster doc passes the resulting id forward (via claim code or `LaunchConfig`) to the launch command.
- The fix is scoped to the launch path scaffolder; orchestrator-side identity reading from `GENERACY_CLUSTER_ID` env var stays unchanged.
- generacy-cloud#801 (sibling stuck `connecting`) is being handled separately and does not block this work.

## Out of Scope

- Migration/reconciliation of existing mismatched local clusters (fresh clusters only).
- Changes to `generacy deploy` (already correct).
- The sibling-cluster `connecting` issue (generacy-cloud#801).
- Cloud-side cluster-doc id minting strategy beyond ensuring it is returned to the launch path.
- Tunnel-name collision handling (#743 already covers the actual-vs-requested name reporting).

## Related Issues

- **#744** — Cluster-id minting (Q3: cloud-minted clusterId). This fix aligns with that direction.
- **#742** — Orchestrator identity / assignee filtering (broken by the identity split).
- **#743** — Tunnel name actual-vs-requested reporting (independent, but adjacent).
- **generacy-cloud#792 / #796 / #801** — Related cloud-side cluster identity/connection issues.

---

*Generated by speckit*
