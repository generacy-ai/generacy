# Feature Specification: ## Summary

On a cloud-deployed cluster, the VS Code dev-tunnel name is derived from the **projectId**, not the per-cluster **UUID** — so #744's per-cluster tunnel naming is **not taking effect on cloud deploys**

**Branch**: `746-summary-cloud-deployed-cluster` | **Date**: 2026-06-03 | **Status**: Draft

## Summary

## Summary

On a cloud-deployed cluster, the VS Code dev-tunnel name is derived from the **projectId**, not the per-cluster **UUID** — so #744's per-cluster tunnel naming is **not taking effect on cloud deploys**. Two clusters of the same project would therefore collide on the same tunnel name, which is exactly what #744 set out to prevent.

## Evidence

- Cloud cluster doc is UUID-keyed: `organizations/vnVZ…/clusters/325cdcb9-5b8e-45fc-a1bc-1ec8570d561d` (project `Xr7fxq61PF57U2lOtoKe`, name `todo-list-example1-cloud-1`).
- Its `vscodeTunnelName` is **`g-xr7fxq61pf57u2loto`** — i.e. `g-` + the projectId compacted/sliced. The pre-#744 (#618) behavior.
- Expected per #744: `deriveTunnelName(GENERACY_CLUSTER_ID)` → `g-325cdcb95b8e45fca1` (UUID-derived).
- `deriveTunnelName`/`loadOptionsFromEnv` (`packages/control-plane/src/services/vscode-tunnel-manager.ts`) read `GENERACY_CLUSTER_ID` and key on the UUID.
- cloud-deploy sets `GENERACY_CLUSTER_ID = clusterId` where `clusterId` is the UUID from `preApproveActivationCode` (`generacy-cloud services/api/.../cloud-deploy/digitalocean.ts`, `compose-template.ts` `GENERACY_CLUSTER_ID=${input.clusterId}`).
- The Droplet installs `@generacy-ai` **preview** packages at boot — observed `0.0.0-preview-20260603190235`, which is the current `preview` dist-tag and is timestamped *after* #744 merged (`6f74140`, 19:01 UTC). So the cluster should have #744.

So with #744 code + `GENERACY_CLUSTER_ID = <UUID>`, the tunnel name should be UUID-derived — but it isn't. Something in the chain still yields projectId.

## Hypotheses to investigate

1. **Cluster env**: confirm the running Droplet's actual `GENERACY_CLUSTER_ID` value (is it the UUID, or did it get the projectId?). `cat /opt/generacy/.env` on the Droplet.
2. **Preview provenance**: confirm the `0.0.0-preview-20260603190235` `@generacy-ai/control-plane` tarball actually contains #744's UUID-keyed `deriveTunnelName` (the publish-preview workflow is manual `workflow_dispatch` — verify the ref it built included `6f74140`).
3. **Stale/cached tunnel**: the tunnel name may have been registered on an earlier activation (when `clusterId === projectId`) and persisted; check whether re-activation re-derives it.

## Impact

- Per-cluster tunnel isolation (the #744 goal) is unverified/ineffective on cloud. Two sibling clusters in one project would request the same tunnel name → collision.

## Related note (separate, but adjacent)

The #744 changeset (`.changeset/feat-744-multi-cluster-cli.md`) is **still pending** (unreleased). `@generacy-ai/control-plane` `latest`/`stable` = `0.3.0` without #744, so **stable-channel** cloud clusters won't have #744 at all until the changeset is released. Preview-channel (staging) gets it via `publish-preview`.

## Acceptance criteria

- [ ] A cloud-deployed cluster's `vscodeTunnelName` is derived from its cluster UUID, not the projectId.
- [ ] Two clusters under one project get distinct tunnel names.
- [ ] #744 is released to the `stable` npm channel so prod cloud clusters get per-cluster naming.

Relates: #744, generacy-ai/generacy-cloud#792, generacy-ai/generacy-cloud#795.


## User Stories

### US1: Operator deploying multiple clusters in one project

**As a** project operator who provisions more than one cloud cluster under the same Generacy project,
**I want** each cluster's VS Code dev-tunnel name to be derived from that cluster's UUID (not the shared projectId),
**So that** sibling clusters in the same project don't collide on the same tunnel name and each cluster's IDE remains independently reachable.

**Acceptance Criteria**:
- [ ] A freshly-deployed cloud cluster's `vscodeTunnelName` (as observed in its cloud Firestore doc) matches `deriveTunnelName(GENERACY_CLUSTER_ID)` — i.e. `g-` + first 18 hex chars of the de-hyphenated UUID.
- [ ] Two clusters under one project get distinct tunnel names (verified by argument from UUID uniqueness once SC-001 is confirmed on at least one fresh deploy; per Q4=C, a second Droplet is not required).
- [ ] Existing cloud clusters currently using projectId-derived names self-correct on next restart/activation without any operator action or migration tooling (per Q2=B); no separate migration path is required.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Trace the write path of `vscodeTunnelName` on the cloud cluster doc end-to-end (cluster → relay → cloud, or cloud-side computation) and produce a written diagnosis identifying which layer sets the value. | P0 | Q5=A: gates any in-repo code change. Validates / refutes Assumption #3. |
| FR-002 | Identify the root cause of projectId-derived tunnel naming on the observed cluster (UUID `325cdcb9…`, project `Xr7fxq61PF57U2lOtoKe`) from the three hypotheses (cluster env, preview-package provenance, stale/cached tunnel) or a fourth uncovered by FR-001. | P0 | Diagnosis is the gating deliverable. |
| FR-003 | If the root cause is in the `generacy` repo (e.g. `packages/control-plane/src/services/vscode-tunnel-manager.ts` or env wiring), ship the fix here. If the root cause is in `generacy-cloud` (cloud-deploy templating / cloud-side computation) or in the `publish-preview` release workflow, open a companion issue in the owning repo and ship the diagnosis writeup only. | P1 | Q1=A: #746 does not own cross-repo PRs. |
| FR-004 | When the fix lands (in whichever repo), a fresh cloud-deployed cluster's `vscodeTunnelName` is UUID-derived (matches `deriveTunnelName(GENERACY_CLUSTER_ID)`). | P1 | Verified by FR-005 / SC-001. |
| FR-005 | Verify SC-001 by deploying exactly one fresh cloud cluster end-to-end (DigitalOcean) and observing the `vscodeTunnelName` in the cloud Firestore doc. Static inspection of code + env templates is explicitly insufficient because this bug is a code-vs-deploy mismatch. | P1 | Q4=C. SC-002 is reasoned about from UUID uniqueness rather than verified by a second deploy. |
| FR-006 | Existing cloud clusters do not require forced re-registration. On next restart/activation, `loadOptionsFromEnv` re-derives the tunnel name from `GENERACY_CLUSTER_ID` and #743's persistence writes the corrected name back to the cloud doc. | P2 | Q2=B. No migration tooling. |
| FR-007 | If hypothesis #3 (stale/cached tunnel registration that survives env/code correction) turns out to be the root cause, document the conditions under which a restart alone is insufficient and what (if any) operator action is needed. Do not build migration tooling unless investigation shows restart is provably insufficient. | P3 | Conditional. Default assumption (per FR-006) is restart suffices. |
| FR-008 | Flag, on the separate #744 stable-release tracking task, that prod / `stable`-channel cloud clusters will not get per-cluster tunnel naming until `.changeset/feat-744-multi-cluster-cli.md` is consumed and `@generacy-ai/control-plane@stable` is republished. | P2 | Q3=B. Release itself is out of #746's scope. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `vscodeTunnelName` on a freshly-deployed cloud cluster is UUID-derived. | Equals `deriveTunnelName(<cluster UUID>)` (e.g. `g-325cdcb95b8e45fca1` for UUID `325cdcb9-5b8e-45fc-a1bc-1ec8570d561d`). | Read the cluster's Firestore doc field `vscodeTunnelName` after deploying one fresh cluster (Q4=C). |
| SC-002 | Two clusters in the same project get distinct tunnel names. | Distinct strings, derived per-cluster from per-cluster UUID. | Reasoned from UUID uniqueness + per-UUID derivation once SC-001 is confirmed; not separately deployed. |
| SC-003 | (Tracked on the separate release task, not on #746) `@generacy-ai/control-plane@stable` contains UUID-keyed `deriveTunnelName`. | Latest `stable` tarball includes the #744 change. | Out of scope for #746 closure (Q3=B). |

## Assumptions

- The in-repo `deriveTunnelName` / `loadOptionsFromEnv` in `packages/control-plane/src/services/vscode-tunnel-manager.ts` (post-#744) correctly key on `GENERACY_CLUSTER_ID` (the UUID). To be re-verified against the actually-published preview tarball if FR-001 implicates preview provenance (hypothesis #2).
- The Droplet's `GENERACY_CLUSTER_ID` env var is the UUID (from `preApproveActivationCode` → `compose-template.ts` `GENERACY_CLUSTER_ID=${input.clusterId}`). To be confirmed on the live Droplet via `cat /opt/generacy/.env` (hypothesis #1).
- ~~`vscodeTunnelName` on the cloud cluster doc is populated by the cluster's first tunnel-registration event reported via the relay, not by cloud pre-computing it from projectId.~~ This assumption is **gated by FR-001** (Q5=A) and must be confirmed before any in-repo code change is made; if false, the fix is cloud-side and #746 ships diagnosis + companion issue only.
- #743's cluster-doc persistence of the *actual* registered tunnel name is in effect on the cloud cluster, so the doc self-corrects on cluster restart once the upstream source-of-truth is corrected (relevant to FR-006).

## Out of Scope

- Consuming `.changeset/feat-744-multi-cluster-cli.md` and publishing a new `@generacy-ai/control-plane@stable` (Q3=B — tracked as a separate release-engineering task).
- Cross-repo PRs into `generacy-cloud` or release-workflow repos (Q1=A — automation can't span repos; companion issues are opened instead).
- Building a migration CLI or operator-triggered re-registration procedure for existing clusters (Q2=B — auto-re-derive on restart suffices; only revisit if FR-007's conditional caching scenario is confirmed).
- Deploying a second cluster purely to observe SC-002 (Q4=C — SC-002 is reasoned about from UUID uniqueness).

---

*Generated by speckit*
