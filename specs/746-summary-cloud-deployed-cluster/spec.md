# Feature Specification: Cloud-deployed cluster tunnel name is projectId-derived, not cluster UUID

**Branch**: `746-summary-cloud-deployed-cluster` | **Date**: 2026-06-03 | **Status**: Draft
**Type**: Bug fix | **Issue**: [#746](https://github.com/generacy-ai/generacy/issues/746) | **Relates**: #744, generacy-ai/generacy-cloud#792, generacy-ai/generacy-cloud#795

## Summary

On a cloud-deployed cluster, the VS Code dev-tunnel name is derived from the **projectId**, not the per-cluster **UUID** — so #744's per-cluster tunnel naming is **not taking effect on cloud deploys**. Two clusters of the same project would therefore collide on the same tunnel name, which is exactly what #744 set out to prevent.

## Evidence

- Cloud cluster doc is UUID-keyed: `organizations/vnVZ…/clusters/325cdcb9-5b8e-45fc-a1bc-1ec8570d561d` (project `Xr7fxq61PF57U2lOtoKe`, name `todo-list-example1-cloud-1`).
- Its `vscodeTunnelName` is **`g-xr7fxq61pf57u2loto`** — `g-` + the projectId compacted/sliced. Pre-#744 (#618) behavior.
- Expected per #744: `deriveTunnelName(GENERACY_CLUSTER_ID)` → `g-325cdcb95b8e45fca1` (UUID-derived).
- `deriveTunnelName`/`loadOptionsFromEnv` (`packages/control-plane/src/services/vscode-tunnel-manager.ts`) read `GENERACY_CLUSTER_ID` and key on the UUID.
- cloud-deploy sets `GENERACY_CLUSTER_ID = clusterId` where `clusterId` is the UUID from `preApproveActivationCode` (`generacy-cloud services/api/.../cloud-deploy/digitalocean.ts`, `compose-template.ts`).
- The Droplet installs `@generacy-ai` **preview** packages at boot — observed `0.0.0-preview-20260603190235`, timestamped after #744 merged (`6f74140`, 19:01 UTC). So the cluster should have #744.

With #744 code + `GENERACY_CLUSTER_ID = <UUID>`, the tunnel name should be UUID-derived — but it isn't. Something in the chain still yields projectId.

## Hypotheses to investigate

1. **Cluster env**: confirm the running Droplet's actual `GENERACY_CLUSTER_ID` value (is it the UUID, or did it get the projectId?). `cat /opt/generacy/.env` on the Droplet.
2. **Preview provenance**: confirm the `0.0.0-preview-20260603190235` `@generacy-ai/control-plane` tarball actually contains #744's UUID-keyed `deriveTunnelName` (the publish-preview workflow is manual `workflow_dispatch` — verify the ref it built included `6f74140`).
3. **Stale/cached tunnel**: the tunnel name may have been registered on an earlier activation (when `clusterId === projectId`) and persisted; check whether re-activation re-derives it.

## Related note (separate, but adjacent)

The #744 changeset (`.changeset/feat-744-multi-cluster-cli.md`) is **still pending** (unreleased). `@generacy-ai/control-plane` `latest`/`stable` = `0.3.0` without #744, so **stable-channel** cloud clusters won't have #744 at all until the changeset is released. Preview-channel (staging) gets it via `publish-preview`.

## User Stories

### US1: Cloud cluster operator avoids tunnel-name collisions across sibling clusters

**As a** Generacy user operating multiple cloud-deployed clusters within a single project,
**I want** each cluster to register a VS Code dev-tunnel name that is unique to that cluster's UUID,
**So that** I can run two or more clusters in the same project concurrently without one cluster hijacking another's tunnel.

**Acceptance Criteria**:
- [ ] A freshly cloud-deployed cluster's `vscodeTunnelName` (as stored in the cloud cluster doc) is derived from its cluster UUID via `deriveTunnelName`, not from the projectId.
- [ ] Deploying a second cluster under the same project yields a `vscodeTunnelName` distinct from the first.
- [ ] Existing clusters with projectId-derived tunnel names continue to function (no forced re-registration breakage) OR a documented migration path exists.

### US2: Cloud cluster operator gets the fix on the stable release channel

**As a** Generacy user running cloud clusters on the `stable` npm channel,
**I want** #744's per-cluster tunnel naming to be released to `stable`,
**So that** production cloud clusters benefit from the fix without requiring `preview`-channel overrides.

**Acceptance Criteria**:
- [ ] The #744 changeset (`.changeset/feat-744-multi-cluster-cli.md`) is consumed and `@generacy-ai/control-plane` is published to the `stable` dist-tag at a version that contains the UUID-keyed `deriveTunnelName`.
- [ ] A stable-channel cloud cluster bootstrapped after release picks up the new tunnel-naming behavior at first activation.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Reproduce the bug end-to-end on a fresh cloud-deployed cluster: capture the actual `GENERACY_CLUSTER_ID` value in the Droplet `.env`, the running `@generacy-ai/control-plane` version, and the resulting `vscodeTunnelName` written to the cloud cluster doc. | P0 | Hypothesis triage (#1–#3 above). Determines which layer to fix. |
| FR-002 | Identify the root cause among the three hypotheses (env mis-set, preview tarball missing #744, or stale/cached tunnel registration). | P0 | Single-cause expected; document why ruled-out hypotheses are not contributing. |
| FR-003 | Apply the fix at the layer identified by FR-002. Possible fix locations: (a) `generacy-cloud` cloud-deploy templating (env not set to UUID), (b) `publish-preview` workflow (built from wrong ref), (c) `control-plane` tunnel-name persistence/cache (not re-derived on activation). | P0 | Out of repo for (a)/(b) — coordinate via companion issues. |
| FR-004 | Ensure `deriveTunnelName(GENERACY_CLUSTER_ID)` produces a UUID-derived `g-<18-hex-chars>` name on cloud-deployed clusters, matching the local-deploy behavior added in #744. | P0 | Verify via observed `vscodeTunnelName` in the cloud cluster doc. |
| FR-005 | Verify two cloud-deployed clusters under the same projectId receive distinct `vscodeTunnelName` values. | P0 | Primary regression check. |
| FR-006 | Release the #744 changeset so `@generacy-ai/control-plane` `stable` dist-tag contains UUID-keyed `deriveTunnelName`. | P1 | Required for non-preview cloud deploys to inherit the fix. |
| FR-007 | If a stale/cached tunnel registration is part of the root cause (hypothesis #3), define a re-derivation or migration path so existing clusters converge to UUID-derived names without manual intervention. | P2 | Only applies if FR-002 implicates caching. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cloud-deployed cluster `vscodeTunnelName` matches UUID derivation | 100% of new cloud deploys | Compare `vscodeTunnelName` in cloud cluster doc against `deriveTunnelName(clusterId)` computed locally. |
| SC-002 | Tunnel-name uniqueness across sibling clusters | 0 collisions | Deploy two clusters under one project, observe distinct `vscodeTunnelName` values; attempt simultaneous tunnel `code tunnel` connect — no name conflict. |
| SC-003 | Stable-channel coverage | `@generacy-ai/control-plane` `stable` ≥ first version containing #744 | `npm view @generacy-ai/control-plane dist-tags.stable` and source-inspect `deriveTunnelName`. |
| SC-004 | Time to root-cause identified | Documented in this spec or `plan.md` before any fix is shipped | FR-002 deliverable noted in spec/plan. |

## Assumptions

- The `@generacy-ai/control-plane` `0.0.0-preview-20260603190235` tarball was built from a ref that includes commit `6f74140` (#744). If preview provenance is the cause, this assumption is falsified — fix scope shifts to the publish-preview workflow.
- `GENERACY_CLUSTER_ID` is the only env input to `deriveTunnelName` on cloud clusters (no override env or config file path is in play).
- The cloud-side `vscodeTunnelName` field is populated by the cluster's first tunnel-registration event reported via the relay, not by cloud pre-computing it from projectId.
- `deriveTunnelName` itself (the pure function from #744, `g-` + first 18 hex chars of UUID with hyphens stripped) is correct and not under suspicion.

## Out of Scope

- Changes to the `deriveTunnelName` algorithm itself (already validated by #744 / #608).
- Renaming or migration of tunnel registrations at Microsoft's tunnel service for clusters that have already booted with projectId-derived names — addressed only if FR-007 triggers.
- Cloud UI changes for displaying tunnel names — tracked separately in generacy-cloud#792 / #795.
- Local (non-cloud) deploys — #744 already verified working there.

---

*Generated by speckit*
