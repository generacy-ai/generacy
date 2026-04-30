# Feature Specification: control-plane /state returns hardcoded values

**Branch**: `516-context-identified-during-pre` | **Date**: 2026-04-30 | **Status**: Draft

## Summary

The control-plane `GET /state` endpoint currently returns hardcoded literal values for `status`, `deploymentMode`, and `variant`. This causes cloud-deployed clusters to appear as local clusters, breaking cloud UI features (Claude Max banner, "Stop cluster" button). The fix reads deployment config from environment variables and reflects actual lifecycle state.

## Context

Identified during pre-staging review of merged v1.5 work. The control-plane `/state` endpoint shipped with hardcoded literals — cloud UI branches off these fields (Anthropic step's Claude Max banner, Ready screen's "Stop cluster" button per #438/#441), so cloud-deployed clusters will misbehave because they always look like local clusters.

## Files

- `packages/control-plane/src/routes/state.ts:11-13` — returns `{ status: 'ready', deploymentMode: 'local', variant: 'cluster-base', ... }` as literal values.

## Fix

Read deployment config from environment at startup; pass to `ControlPlaneServer` constructor; expose via `ClusterState` in `server/types.ts`. The cluster image's container entrypoint sets `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars (cluster-base/cluster-microservices entrypoints already know which variant they are; cloud provisioning sets `DEPLOYMENT_MODE=cloud` per Phase 7).

- `DEPLOYMENT_MODE` env var → `deploymentMode` in state response (default `'local'` if unset)
- `CLUSTER_VARIANT` env var → `variant` in state response (default `'cluster-base'`)
- `status` should reflect actual lifecycle state (e.g., `'bootstrapping'` if the activation flow hasn't completed, `'ready'` after handshake, `'degraded'` if relay disconnected, `'error'` on unrecoverable failure)

## User Stories

### US1: Cloud UI displays correct cluster state

**As a** cloud-deployed cluster user,
**I want** the `/state` endpoint to return the actual deployment mode and variant,
**So that** the cloud UI correctly shows features like the Claude Max banner and "Stop cluster" button.

**Acceptance Criteria**:
- [ ] `GET /state` returns `deploymentMode: 'cloud'` when `DEPLOYMENT_MODE=cloud` is set
- [ ] Cloud UI triggers Claude Max banner and "Stop cluster" button for cloud clusters
- [ ] Local clusters continue to show `deploymentMode: 'local'` (default behavior)

### US2: Cluster lifecycle status is accurate

**As a** cluster operator,
**I want** the `status` field to reflect the real lifecycle state,
**So that** I can determine whether the cluster is bootstrapping, ready, degraded, or in error.

**Acceptance Criteria**:
- [ ] Status shows `'bootstrapping'` before activation completes
- [ ] Status shows `'ready'` after successful relay handshake
- [ ] Status shows `'degraded'` if relay disconnects
- [ ] Status shows `'error'` on unrecoverable failure

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Read `DEPLOYMENT_MODE` env var at startup, default to `'local'` | P1 | |
| FR-002 | Read `CLUSTER_VARIANT` env var at startup, default to `'cluster-base'` | P1 | |
| FR-003 | Pass deployment config to `ControlPlaneServer` constructor | P1 | |
| FR-004 | Expose config via `ClusterState` type in `server/types.ts` | P1 | |
| FR-005 | Implement lifecycle status state machine (`bootstrapping` → `ready` ↔ `degraded` → `error`) | P1 | |
| FR-006 | `GET /state` returns dynamic values from config + lifecycle state | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Env var propagation | 100% correct | Integration test with each combination of env vars |
| SC-002 | Cloud UI feature gates | All triggered correctly | Cloud cluster shows `deploymentMode: 'cloud'` |
| SC-003 | Status accuracy | Reflects real state | Status transitions verified in integration test |

## Acceptance Criteria (from issue)

- `GET /state` returns values reflecting the running container's actual deployment mode and variant.
- `status` field reflects the cluster's real lifecycle state (not always 'ready').
- Cloud-deployed cluster shows `deploymentMode: 'cloud'`, triggering Anthropic step's Claude Max banner and Ready screen's "Stop cluster" button.
- Test: integration test boots the service with each combination of env vars and asserts response shape.

## Background

Original issue: #490. Decided in clarification: status enum `'bootstrapping' | 'ready' | 'degraded' | 'error'`; deploymentMode `'local' | 'cloud'`; variant `'cluster-base' | 'cluster-microservices'` (extensible enum).

## Assumptions

- Container entrypoints already set `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars correctly
- Cloud provisioning sets `DEPLOYMENT_MODE=cloud` (per Phase 7)
- The status state machine can be wired to relay connection events

## Out of Scope

- Adding new deployment modes beyond `'local'` and `'cloud'`
- Adding new variants beyond `'cluster-base'` and `'cluster-microservices'`
- Cloud UI implementation changes (consuming the corrected API is already implemented)

---

*Generated by speckit*
