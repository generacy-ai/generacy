# Feature Specification: Per-cluster tunnel name + identity for multi-cluster

**Branch**: `744-summary-cluster-cli` | **Date**: 2026-06-03 | **Status**: Draft
**Issue**: [generacy-ai/generacy#744](https://github.com/generacy-ai/generacy/issues/744)
**Companions**: generacy-ai/generacy-cloud#792 (data model + UI), generacy-ai/generacy-cloud#791 (interim clobber guard), generacy-ai/generacy-cloud#789 (cloud stop/start). Relates: #743 (tunnel actual-name).

## Summary

Cluster/CLI/orchestrator-side support for **multiple clusters per project** with **user-named clusters**. This issue covers the pieces that live in `generacy` (the published `@generacy-ai/*` packages and the CLI scaffolder). The cloud-side data model and UI are tracked separately in generacy-cloud#792.

## Background

A cluster currently derives its tunnel name from its id: `deriveTunnelName(clusterId)` = `g-${clusterId.replace(/-/g,'').slice(0,18)}` (control-plane `vscode-tunnel-manager.ts`) — exactly **20 chars**, which is the VS Code tunnel-name ceiling (≤20, lowercase `[a-z0-9-]`, must start with a letter). An earlier attempt used a raw UUID as the tunnel name and it was **too long** — hence the short derived form. #743 already persists the *actual* registered tunnel name (parsed from the `vscode.dev/tunnel/<name>` URL) rather than the requested one.

Multi-cluster means a project no longer maps to one cluster, so the CLI and orchestrator must carry a **per-cluster UUID + human name**, and tunnel names must stay unique and within the constraint.

## User Stories

### US1: Launch a named cluster

**As a** developer working on a project with multiple Generacy clusters,
**I want** to give each cluster a meaningful name at `generacy launch` time (e.g. `acme-frontend-local`, `acme-staging-local`),
**So that** I can tell my clusters apart in the cloud dashboard and on my own machine, without juggling raw UUIDs.

**Acceptance Criteria**:
- [ ] `generacy launch --name <name>` accepts a human cluster name and persists it into the scaffolded cluster identity.
- [ ] When `--name` is omitted, the CLI generates a default of the form `<sanitized-project>-local-<n>`, mirroring the cloud generator.
- [ ] The name is fixed at creation and is not mutated by later commands.

### US2: Run multiple clusters per project without tunnel collisions

**As a** developer with two or more clusters under the same project,
**I want** each cluster to register a distinct VS Code dev tunnel name within the 20-char/lowercase/letter-initial constraint,
**So that** opening one cluster's IDE doesn't clobber another's tunnel, and the cloud can show each cluster's tunnel correctly.

**Acceptance Criteria**:
- [ ] `deriveTunnelName` is keyed on the **cluster UUID** (not the projectId), so distinct clusters yield distinct tunnel names.
- [ ] The helper and its constraint contract (≤20 chars, lowercase `[a-z0-9-]`, starts with a letter) are documented in code next to the helper.
- [ ] Two clusters in the same project register without colliding on tunnel name or cluster identity.

### US3: Cluster identity surfaces in registration

**As a** cloud operator viewing a project's clusters,
**I want** each cluster to register itself with its UUID **and** display name,
**So that** the cloud (generacy-cloud#792) can show the user-facing cluster name without recomputing it from the tunnel name.

**Acceptance Criteria**:
- [ ] Orchestrator cluster identity (relay registration, metadata) carries both the UUID and the display name.
- [ ] The short derived tunnel name remains decoupled from the display name (different fields, different lifecycles).

### US4: Releasing a tunnel name on stop / delete

**As a** developer tearing down a cluster,
**I want** its dev tunnel to be unregistered/turned off so the name is freed,
**So that** I can recreate a cluster (or reuse the same id elsewhere) without zombie tunnels lingering in my Microsoft account.

**Acceptance Criteria**:
- [ ] `generacy stop` / `generacy down` / `generacy destroy` cause the cluster's dev tunnel to be unregistered (or at minimum stopped) before container teardown completes.
- [ ] Re-launching a cluster with the same UUID after a clean delete succeeds and registers the tunnel without "name already in use" errors from Microsoft's tunnel service.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `deriveTunnelName(clusterId)` MUST be keyed on the cluster UUID (not projectId) so two clusters under one project yield distinct ≤20-char tunnel names. | P1 | Lives in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. Existing behavior already keys on cluster UUID per #608; verify and document. |
| FR-002 | The tunnel-name constraint (≤20 chars, lowercase `[a-z0-9-]`, must start with a letter) MUST be documented in code immediately adjacent to `deriveTunnelName`. | P1 | Comment + matching regex assertion in the helper. |
| FR-003 | `generacy launch` MUST accept an optional `--name <name>` flag, validated as non-empty. | P1 | Commander flag on `packages/generacy/src/cli/commands/launch/index.ts`. |
| FR-004 | When `--name` is omitted, the CLI MUST generate a default name of the form `<sanitized-project>-local-<n>`, where `<n>` is the next free integer for that project on the local machine. | P1 | Uniqueness scope = local registry (`~/.generacy/clusters.json`); see clarify Q2. |
| FR-005 | The scaffolder MUST persist the cluster name into the cluster identity files (`.generacy/cluster.json` and/or `.generacy/.env`) at creation time. | P1 | `packages/generacy/src/cli/commands/cluster/scaffolder.ts`. |
| FR-006 | The persisted cluster name MUST be immutable after creation — no CLI command in this scope mutates it. | P1 | Renaming is out of scope; see Out of Scope. |
| FR-007 | The orchestrator MUST surface both the cluster UUID and the display name in its relay registration / metadata payload. | P1 | `ClusterMetadataPayload`-style field in `packages/cluster-relay` and the relay-bridge `collectMetadata()`. |
| FR-008 | The display name MUST be decoupled from the derived tunnel name; renaming a cluster (if ever supported) must not change the tunnel name, and vice versa. | P1 | Distinct fields in the metadata payload. |
| FR-009 | `generacy stop`, `generacy down`, and `generacy destroy` MUST unregister (or at least stop) the VS Code dev tunnel for the cluster being torn down. | P1 | Likely a control-plane lifecycle action invoked from CLI; pairs with #743. |
| FR-010 | Tunnel unregistration MUST be best-effort and idempotent — failure to release MUST NOT block container teardown but MUST surface a warning. | P2 | Match existing CLI lifecycle command UX (warn-and-continue). |
| FR-011 | The CLI MUST register the user-provided / generated cluster name in the local registry (`~/.generacy/clusters.json`) alongside the existing `clusterId`. | P1 | Schema update in `packages/generacy/src/registry/`. |
| FR-012 | When two clusters' UUIDs would produce colliding `g-<uuid18>` tunnel names, the orchestrator MUST detect the collision at tunnel-start and emit a clear `cluster.vscode-tunnel` error event. | P2 | Probabilistically rare (18 hex chars), but cheap to guard. See clarify Q4. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cluster scaffolding accepts a name flag | 100% of `generacy launch --name foo` runs persist `foo` into `cluster.json` | Manual + integration test asserting file contents after scaffold |
| SC-002 | Default cluster names are unique per project on a single machine | Zero name collisions across N launches of the same project (N ≤ 10) | Integration test that runs `generacy launch` ten times for one project, asserts ten distinct names |
| SC-003 | Two clusters under the same project register distinct tunnel names | Both clusters' `cluster.vscode-tunnel` events show different tunnel names | E2E test against two scaffolded clusters with distinct UUIDs |
| SC-004 | Tunnel name conforms to VS Code constraint | 100% of derived tunnel names match `^[a-z][a-z0-9-]{0,19}$` | Property test on `deriveTunnelName` |
| SC-005 | Tunnel release on teardown | `generacy stop`/`down`/`destroy` cause the dev tunnel to no longer appear in `code tunnel list` within 30s | Manual verification + integration test on a test Microsoft account |
| SC-006 | Display name surfaces in cloud | The cloud dashboard (generacy-cloud#792) reads the display name from registration metadata without recomputing it | Cross-repo integration check |

## Assumptions

- The cluster UUID continues to be minted at activation/scaffold time and is stable for the lifetime of the cluster (no UUID churn).
- VS Code's tunnel-name constraint (≤20 chars, lowercase `[a-z0-9-]`, starts with a letter) holds — if Microsoft relaxes it, the helper still works.
- The local registry (`~/.generacy/clusters.json`) is the source of truth for default-name uniqueness; cloud-side uniqueness is handled by generacy-cloud#792.
- `code tunnel unregister` (or equivalent) is available in the orchestrator image and can be invoked by the control-plane on lifecycle action.
- The cluster name does not need to be modifiable post-creation in this milestone (rename is a separate feature if needed).

## Out of Scope

- **Cluster rename** after creation (display name is immutable in this milestone).
- **Cloud-side data model / UI** for multi-cluster — covered by generacy-cloud#792.
- **Interim clobber guard** in the cloud — covered by generacy-cloud#791.
- **Cloud stop/start lifecycle** — covered by generacy-cloud#789.
- **Migrating existing single-cluster projects** to the multi-cluster model (data migration is the cloud's responsibility; CLI just writes the new fields going forward).
- **Choosing between UUID-derived vs name-derived tunnel names** — recommendation in clarify Q1 is to keep UUID-derived; deferred to /clarify if disputed.

## Open Questions for /clarify

1. **Tunnel name source**: keep UUID-derived (`g-<uuid18>`) or derive from a sanitized name + uniqueness suffix? (Recommend UUID-derived — already unique and within budget.)
2. **Default-name uniqueness scope** for local clusters: per project? per project+mode (local vs cloud)? Should match the cloud generator (generacy-cloud#792 Q2).
3. **Where the local cluster's UUID is minted** (CLI at scaffold time vs cloud assigns it during activation) so cloud + local agree on the id.
4. **Tunnel-name collision handling** if two clusters' `g-<uuid18>` prefixes ever coincide (probabilistically rare with 18 hex chars; FR-012 makes it a loud error rather than silent corruption — confirm acceptable).

---

*Generated by speckit*
