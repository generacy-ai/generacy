# Implementation Plan: Cloud cluster VS Code tunnel name still derived from projectId

**Feature**: Diagnose why cloud-deployed clusters' `vscodeTunnelName` is projectId-derived despite #744 shipping per-cluster (UUID) naming, then either fix in-repo or hand off via companion issue.
**Branch**: `746-summary-cloud-deployed-cluster`
**Status**: Complete
**Date**: 2026-06-03
**Spec**: [spec.md](./spec.md)

## Summary

#744 introduced `deriveTunnelName(GENERACY_CLUSTER_ID)` so each cluster's VS Code dev-tunnel name is UUID-derived. A live cloud cluster (`325cdcb9-…`, project `Xr7fxq61PF57U2lOtoKe`) running a post-#744 preview tarball still shows `vscodeTunnelName = "g-xr7fxq61pf57u2loto"` — i.e. the pre-#744 projectId-derived name.

The in-repo `deriveTunnelName` / `loadOptionsFromEnv` in `packages/control-plane/src/services/vscode-tunnel-manager.ts` already keys on the UUID (verified). So the bug is most likely **outside this repo**: cloud-side computation of `vscodeTunnelName` (generacy-cloud), preview-package provenance (`publish-preview` workflow), or a cached/stale registration that survives env correction.

This work is **diagnosis-led** (per Q5=A, Q1=A): trace the write path of `vscodeTunnelName` first; only ship in-repo code if the root cause turns out to live here; otherwise file companion issues and close #746 on the writeup.

## Technical Context

**Language/Version**: TypeScript 5.x / Node >= 22
**Primary Dependencies**: existing — `node:child_process`, `zod`, `ws` (control-plane, cluster-relay, orchestrator)
**Storage**: Cloud Firestore (`organizations/{orgId}/clusters/{clusterId}` — `vscodeTunnelName` field). Out-of-repo write path under investigation.
**Testing**: Existing Vitest suites for `deriveTunnelName` + `loadOptionsFromEnv`. Verification of the live deployed behavior is by end-to-end DigitalOcean deploy (Q4=C).
**Target Platform**: Cloud-deployed Generacy clusters (DigitalOcean Droplets) running cluster-base + `@generacy-ai/*` preview tarballs.
**Project Type**: Multi-package monorepo (pnpm). This feature touches at most `packages/control-plane/` and at most for tunnel-name handling; most of the work is read-only investigation.
**Performance Goals**: N/A — diagnosis + (conditional) targeted fix.
**Constraints**:
- No cross-repo PRs from #746 (Q1=A). Companion issues only.
- No migration tooling (Q2=B). Clusters self-correct on next restart via `loadOptionsFromEnv` + #743 persistence.
- No `stable`-channel publish from #746 (Q3=B). Tracked separately as a release task.
- Verification requires one fresh end-to-end cloud deploy (Q4=C). Static inspection alone is insufficient.

**Scale/Scope**: Single bug touching one field on the cluster doc. The deliverable is **either** a small, targeted in-repo patch **or** a written diagnosis + companion issue.

## Constitution Check

*No `.specify/memory/constitution.md` present in this repo.* No project-level governance gates to evaluate. The implicit constraints honored:

- Spec-first, evidence-driven changes (the spec mandates FR-001 as a P0 investigation step before any code).
- Single-purpose PRs — if a fix lands here it is scoped to tunnel-name resolution only.
- No speculative refactors; no new abstractions.

## Project Structure

### Documentation (this feature)

```text
specs/746-summary-cloud-deployed-cluster/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Batch 1 clarifications (Q1–Q5)
├── plan.md              # This file
├── research.md          # Phase 0 — write-path trace, three hypotheses, decisions
├── data-model.md        # Phase 1 — entities involved (cluster doc field, env, relay event)
├── quickstart.md        # Phase 1 — how to reproduce, verify, and inspect the live cluster
├── contracts/           # (empty — no new contracts)
└── tasks.md             # Phase 2 — produced by `/speckit:tasks`
```

### Source Code (repository root — touched areas only)

```text
packages/control-plane/
└── src/services/
    └── vscode-tunnel-manager.ts        # deriveTunnelName + loadOptionsFromEnv (already UUID-keyed post-#744)

packages/orchestrator/
└── src/services/relay-bridge.ts        # collectMetadata → metadata.codeServerReady etc.
                                        # may carry tunnelName field; read-only for FR-001

packages/cluster-relay/
└── src/messages.ts                     # cluster.vscode-tunnel event payload schema (read-only for FR-001)

# Out-of-repo (READ-ONLY references — companion issues filed here if implicated):
# - generacy-cloud:    services/api/.../cloud-deploy/{digitalocean.ts, compose-template.ts}
# - generacy-cloud:    relay handler that writes `vscodeTunnelName` to Firestore
# - generacy workflow: .github/workflows/publish-preview.* (ref-pinning for the preview tarball)
```

**Structure Decision**: No new files added by default. If FR-002's root cause is in-repo (low-probability per Q1 note), the fix lands inside `packages/control-plane/src/services/vscode-tunnel-manager.ts` and is single-file. The remaining deliverable is documentation that lives under `specs/746-…/`.

## Complexity Tracking

No constitution violations. No abstractions, new packages, or new persistence introduced. The plan deliberately stays inside the spec's narrow diagnostic frame.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none)    | —          | —                                    |
