# Clarifications

## Batch 1 — 2026-06-04

### Q1: Root cause location
**Context**: The launch scaffolder already uses `config.clusterId` from the cloud `LaunchConfig` (see `packages/generacy/src/cli/commands/launch/scaffolder.ts:71-114`). The launch path writes that id into `.env` (`GENERACY_CLUSTER_ID`) and host-side `.generacy/cluster.json`. Separately, the orchestrator's activation flow writes `pollResult.cluster_id` into the container-side `/var/lib/generacy/cluster.json` (`packages/orchestrator/src/activation/index.ts:160-166`). So a split can only arise if (a) the cloud's `buildLaunchConfig` returns a different id than the device-code `poll` endpoint, OR (b) the CLI mints/overwrites the id somewhere we missed. The original bug report notes the exact mint site wasn't root-caused. Implementation direction depends on the answer.
**Question**: Where is the id mismatch actually introduced?
**Options**:
- A: Cloud-side — `buildLaunchConfig` (or the web "Add cluster → local" flow) returns one cluster id, but the device-code `poll` endpoint mints/returns a different one. Both endpoints disagree.
- B: Client-side — somewhere in the launch CLI a locally-minted UUID overrides `config.clusterId` before scaffolding (need to find the site).
- C: Unknown / both — root-causing the exact mint site is part of this fix's deliverables.
- D: Pre-activation volume contamination — a previously-activated cluster's `cluster.json` survives in a Docker volume and gets reused on the next launch (`clearStaleActivation` exists for this — possibly insufficient).

**Answer**: *Pending*

### Q2: Canonical id source when LaunchConfig.clusterId ≠ pollResult.cluster_id
**Context**: The relay handshake authenticates with the API key, which is associated with `pollResult.cluster_id` on the cloud side. So `pollResult.cluster_id` is what cloud-side Firestore queries will resolve. But `LaunchConfig.clusterId` is what the user "added" via the web "Add cluster → local" flow. These should be the same — but if cloud returns different ids, which one becomes `GENERACY_CLUSTER_ID`?
**Question**: When the two cloud-returned ids disagree, which one is the single source of truth?
**Options**:
- A: `pollResult.cluster_id` wins. The orchestrator rewrites `.env` (and the host-side `cluster.json`) post-activation to match the id the API key authenticates as. Tunnel/identity correctness over user intent.
- B: `LaunchConfig.clusterId` wins. The cloud must guarantee `poll` returns the same id (cloud-side fix). The client treats divergence as an error.
- C: Fail-fast. Orchestrator detects divergence and refuses to start, surfacing an actionable error message ("cloud returned mismatched ids — report this").

**Answer**: *Pending*

### Q3: Cloud-side coordination required?
**Context**: Spec's Out-of-Scope explicitly lists "Cloud-side cluster-doc id minting strategy beyond ensuring it is returned to the launch path". FR-004 says "verify cloud `buildLaunchConfig` returns the doc id" — implying the cloud already does so, or this fix only verifies it. But if Q1=A (cloud is the source of the split), the fix can't be purely client-side.
**Question**: Does this fix require a companion cloud-side PR (`generacy-ai/generacy-cloud`)?
**Options**:
- A: Strictly client-side. Cloud already returns the correct id; fix is only in `packages/generacy` and/or `packages/orchestrator`. Spec scope unchanged.
- B: Companion cloud PR required. File a separate cloud issue and treat this issue as blocked/dependent until cloud lands the fix. Note in spec.
- C: Both sides. Client adds detection/reconciliation; cloud ensures id consistency. Document the cloud companion as a related issue but proceed with client work in parallel.

**Answer**: *Pending*

### Q4: Existing mismatched clusters at orchestrator startup
**Context**: FR-005 says "Existing local clusters with mismatched ids MUST NOT be silently rewritten. Reconciliation/migration is out of scope". But the orchestrator boots on every restart — it will repeatedly observe the mismatch. What should it do?
**Question**: When the orchestrator starts and detects `process.env.GENERACY_CLUSTER_ID` ≠ persisted `cluster.json.cluster_id`, how should it behave?
**Options**:
- A: Log a single warning at startup (`cluster.identity-split-detected`), proceed normally. Visible in logs and metadata, but not surfaced as an error to the user.
- B: Push a relay error event (`cluster.identity-split`) and continue. Cloud-side UI can surface a remediation banner ("destroy and re-launch this cluster").
- C: Refuse to start (`process.exit(1)`). Forces remediation but breaks existing mismatched clusters until manually destroyed/re-launched.
- D: No detection at all — fix only ensures *fresh* launches scaffold correctly; existing clusters keep working as-is.

**Answer**: *Pending*

### Q5: Activation-time `.env` rewrite when ids diverge
**Context**: If Q2=A (pollResult wins) and the cloud actually returns divergent ids, the orchestrator would need to update `GENERACY_CLUSTER_ID` to the right value. The orchestrator runs inside Docker, where `/var/lib/generacy/cluster.json` is in a named volume but `.env` is on the host (mounted as compose env-file). Mid-container env mutation doesn't propagate back to the host `.env` or to already-spawned worker processes without a container restart.
**Question**: If the orchestrator detects the split and Q2=A is the chosen behavior, how should it reconcile?
**Options**:
- A: Best-effort in-container only — orchestrator process uses `pollResult.cluster_id` internally (overrides `GENERACY_CLUSTER_ID`), but doesn't try to rewrite host `.env`. Workers re-read it from a control-plane endpoint or cluster.json instead of trusting env.
- B: Write the corrected value into a runtime-state file (e.g. `/var/lib/generacy/runtime-identity.json`) that orchestrator + workers consult first, falling back to env. Host `.env` is left as-is; relay metadata reflects the runtime value.
- C: This won't happen if cloud guarantees consistency (Q2=B/Q3=B/C) — defer reconciliation logic until/unless the divergence is actually observed in practice.

**Answer**: *Pending*
