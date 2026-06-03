# Research: Cloud cluster `vscodeTunnelName` projectId regression

**Feature**: 746-summary-cloud-deployed-cluster
**Status**: Complete
**Date**: 2026-06-03

This document captures the technology decisions, alternatives considered, and the FR-001 investigation plan (write-path trace) that gates all subsequent work.

---

## Decision 1 — Diagnosis-first, not code-first

**Decision**: Treat #746 as an investigation, not a code change. FR-001 (trace where `vscodeTunnelName` is written on the cloud cluster doc) is P0 and gates any in-repo edit (Q5=A).

**Rationale**:
- In-repo `deriveTunnelName` / `loadOptionsFromEnv` (`packages/control-plane/src/services/vscode-tunnel-manager.ts:64–88`) already key on `GENERACY_CLUSTER_ID` (UUID). The observed value `g-xr7fxq61pf57u2loto` cannot be produced by that function from the UUID `325cdcb9-…`.
- A patch here would be speculative and could mask the real cause.
- Cost of the investigation step is low (read-only); cost of fixing the wrong layer is high (wasted release, persistent collision risk).

**Alternatives considered**:
- *Patch first, investigate later.* Rejected — the in-repo function is verifiably correct on the UUID path, so any patch would be a workaround, not a fix.
- *Open a generacy-cloud issue immediately without a trace.* Rejected — the spec wants an evidence-backed diagnosis pointing at a specific layer, not a guess.

---

## Decision 2 — Verification by ONE fresh end-to-end deploy (SC-001), reasoning for SC-002

**Decision**: Confirm SC-001 by deploying exactly one fresh DigitalOcean cluster end-to-end and reading `vscodeTunnelName` from its Firestore doc. SC-002 (sibling distinctness) follows by argument from UUID uniqueness + per-UUID derivation.

**Rationale**: Q4=C. The bug is a code-vs-deploy mismatch — code looked correct but deployed behavior was wrong. Static inspection alone is insufficient. A second sibling deploy is unnecessary infrastructure spend; uniqueness is mathematically guaranteed once SC-001 is confirmed.

**Alternatives considered**:
- *Two sibling deploys (Q4=A).* Rejected — duplicate infra cost for no information gain beyond SC-001.
- *Static-only verification (Q4=B).* Rejected — explicitly identified as insufficient for this bug class.

---

## Decision 3 — No migration tooling; rely on restart self-correction

**Decision**: Existing cloud clusters auto-correct on next restart/activation via `loadOptionsFromEnv` re-deriving + #743 cluster-doc persistence writing the corrected name back. No CLI migration command, no operator playbook (Q2=B).

**Rationale**: `loadOptionsFromEnv` runs at boot; #743 persists the *actual* registered tunnel name into the cluster doc; once the upstream source-of-truth is corrected, the doc self-heals on the next restart. FR-007 keeps a conditional carve-out *only* if hypothesis #3 (stale cache surviving restart) turns out to be the root cause.

**Alternatives considered**:
- *No migration, leave existing clusters on projectId names (Q2=A).* Rejected — defeats the per-cluster isolation goal of #744 for any existing cluster.
- *Operator-triggered migration CLI (Q2=C).* Rejected — tooling overhead unjustified when restart suffices.

---

## Decision 4 — Stable-channel publish of #744 is out of scope

**Decision**: #746 closes once SC-001 is verified on the **preview** channel. Consuming `.changeset/feat-744-multi-cluster-cli.md` and publishing `@generacy-ai/control-plane@stable` is a separate release-engineering task (Q3=B). FR-008 flags the dependency on that task; #746 does not own it.

**Rationale**: Release cadence is orthogonal to this bug. Cloud-deploy uses preview tarballs at the moment, which is exactly where the bug surfaced and where the fix is verified.

**Alternatives considered**:
- *Block #746 on stable release (Q3=A).* Rejected — couples a bug fix to release cadence unnecessarily.
- *Conditional ownership (Q3=C).* Rejected — adds branching ownership rules with no benefit.

---

## Decision 5 — In-repo fix only if root cause is in `generacy`

**Decision**: If FR-001 traces the bug to an in-repo file, ship the fix here. If it traces to `generacy-cloud` (cloud-deploy template, relay handler that writes `vscodeTunnelName`) or to the `publish-preview` workflow, file a companion issue in the owning repo and ship only the diagnosis writeup from #746 (Q1=A).

**Rationale**: Automation can't span repos; #746 must close on its own merits. Diagnosis is the gating, valuable deliverable regardless of where the fix lives.

**Alternatives considered**:
- *End-to-end ownership including cross-repo PRs (Q1=B).* Rejected — out of scope for a single repo's issue.
- *Hybrid: leave #746 open until companion PRs land (Q1=C).* Rejected — adds tracking overhead with no benefit over a companion issue.

---

## FR-001 investigation — the write path of `vscodeTunnelName`

This is the gating P0 deliverable. The investigation is read-only and produces a written diagnosis. Three layers to inspect, in order:

### Layer A — Cluster process (in this repo)

- `packages/control-plane/src/services/vscode-tunnel-manager.ts`
  - `deriveTunnelName(clusterId)` strips hyphens, prefixes `g-`, slices first 18 hex chars. Verified UUID-keyed (line 64–71).
  - `loadOptionsFromEnv` reads `GENERACY_CLUSTER_ID` (line 81). Verified UUID-keyed.
  - Tunnel events emitted on `cluster.vscode-tunnel` via `getRelayPushEvent()`. Carries `tunnelName?: string` (actual, post-fallback).
- `packages/orchestrator/src/services/relay-bridge.ts` — `collectMetadata()` is the periodic heartbeat path; check whether it ships any `tunnelName` field today and what source it reads from.
- `packages/cluster-relay/src/messages.ts` — `EventMessage` and metadata payload shape (read-only; identify which channel/field carries the name to cloud).

**Probe inside the running Droplet** (manual, per quickstart.md):
1. `cat /opt/generacy/.env | grep GENERACY_CLUSTER_ID` — confirm the UUID is what the process sees (hypothesis #1).
2. `docker compose logs orchestrator | grep -iE 'tunnel|deriveTunnelName'` — confirm what name the cluster requested.
3. Inspect the preview tarball: `docker compose exec orchestrator node -e "console.log(require('@generacy-ai/control-plane/package.json').version)"` and `grep -n GENERACY_CLUSTER_ID node_modules/@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js` — confirm the published code actually has #744 (hypothesis #2).

### Layer B — generacy-cloud relay handler

- The relay receives `cluster.vscode-tunnel` events. The handler that persists `vscodeTunnelName` to `organizations/{orgId}/clusters/{clusterId}` is in `generacy-cloud`. Inspect:
  - Does the handler read `tunnelName` from the relay event payload, or does it compute `g-${projectId.slice(...)}` cloud-side?
  - Was the doc last written by a pre-#744 cluster process that registered under projectId, and is the handler write-once / merge-only?
- The cluster doc was also visible at deploy creation time (`preApproveActivationCode`); inspect whether that codepath seeds `vscodeTunnelName` before the cluster has registered.

### Layer C — publish-preview workflow

- `.github/workflows/publish-preview.*` (or equivalent in the `generacy-ai/control-plane` build pipeline) is manual `workflow_dispatch`. Confirm the dispatch ref for the `0.0.0-preview-20260603190235` tarball included #744's merge SHA `6f74140` (or a descendant).
- If the tarball was built from a ref *before* `6f74140`, the cluster has pre-#744 code despite the timestamp suggesting otherwise.

### Three hypotheses (from spec) — mapping to layers

| # | Hypothesis | Inspect | Disposition |
|---|------------|---------|-------------|
| 1 | Droplet env actually has projectId, not UUID | Layer A probe 1 | If true: fix is in `generacy-cloud` compose-template.ts (companion issue). |
| 2 | Preview tarball doesn't actually contain #744 | Layer A probe 3 + Layer C | If true: fix is in the release workflow / changeset (companion issue). |
| 3 | Stale/cached tunnel registration survives | Layer A logs + Layer B handler shape | If true: FR-007 — document the conditions; only build tooling if restart provably insufficient. |

A fourth possibility — cloud-side pre-computation of `vscodeTunnelName` from projectId — is surfaced by Layer B and is the one that, if true, makes the entire in-repo path moot.

---

## Implementation patterns

- **Atomic, reversible diagnosis**: write findings into `specs/746-…/research.md` as Layer A/B/C is investigated. Each layer's conclusion either pins or eliminates a hypothesis.
- **Cite line numbers** in `packages/control-plane/src/services/vscode-tunnel-manager.ts` for any in-repo claim — code may have moved since the spec was written.
- **Companion-issue boilerplate** (if Layer B or C): include observed UUID, observed tunnel name, expected tunnel name from `deriveTunnelName`, the trace step that pinned the layer, and a pointer to this `research.md`.

---

## Key sources / references

- Issue #744 — per-cluster (UUID) tunnel naming. Commit `6f74140` on `develop`.
- Issue #743 — control-plane reports *actual* registered tunnel name back to cloud. Underwrites FR-006's "self-correct on restart" guarantee.
- Issue #608 — `deriveTunnelName` origin (20-char limit for Microsoft tunnel service).
- Issue #618 — the pre-#744 projectId-derived design, intentionally chosen for stability across activations of a single cluster.
- generacy-cloud#792, generacy-cloud#795 — companion cloud-side per-cluster persistence (referenced by spec).
- File: `packages/control-plane/src/services/vscode-tunnel-manager.ts:64–88` (verified UUID-keyed).
