# Feature Specification: Per-cluster tunnel name + identity for multi-cluster

**Branch**: `744-summary-cluster-cli` | **Date**: 2026-06-03 | **Status**: Draft
**Issue**: [generacy-ai/generacy#744](https://github.com/generacy-ai/generacy/issues/744)
**Companions**: generacy-ai/generacy-cloud#792 (data model + UI), generacy-ai/generacy-cloud#791 (interim clobber guard), generacy-ai/generacy-cloud#789 (cloud stop/start). Relates: #743 (tunnel actual-name).

## Summary

Cluster/CLI/orchestrator-side support for **multiple clusters per project** with **user-named clusters**. This issue covers the pieces that live in `generacy` (the published `@generacy-ai/*` packages and the CLI scaffolder). The cloud-side data model and UI are tracked separately in generacy-cloud#792.

## Background

A cluster currently derives its tunnel name from its id: `deriveTunnelName(clusterId)` = `g-${clusterId.replace(/-/g,'').slice(0,18)}` (control-plane `vscode-tunnel-manager.ts`) — exactly **20 chars**, which is the VS Code tunnel-name ceiling (≤20, lowercase `[a-z0-9-]`, must start with a letter). An earlier attempt used a raw UUID as the tunnel name and it was **too long** — hence the short derived form. #743 already persists the *actual* registered tunnel name (parsed from the `vscode.dev/tunnel/<name>` URL) rather than the requested one.

Multi-cluster means a project no longer maps to one cluster, so the CLI and orchestrator must carry a **per-cluster UUID + human name**, and tunnel names must stay unique and within the constraint.

## Clarifications

Answers resolved in `clarifications.md` (Batch 1, 2026-06-03):

- **Q1 (Tunnel name source)** → **A**: Keep UUID-derived (`g-<uuid18>`). Tunnel name stays decoupled from the display name; no sanitization/collision handling required at the helper level.
- **Q2 (Default-name uniqueness scope)** → **B**: Per `projectId` + deployment mode — only count clusters where `deploymentMode === 'local'`. Cloud/SSH clusters increment a separate sequence (matches the `-local-` literal in the pattern and #792's per-(project, mode) decision).
- **Q3 (Cluster UUID minting site)** → **A**: Cloud-minted (status quo). CLI scaffolds with no `cluster_id`; activation device-flow returns the id, CLI writes it back. Default name `<project>-local-<n>` is computed independently of activation, from the local registry.
- **Q4 (Name validation and sanitization)** → **B**: Permissive + normalize. Accept any non-empty `--name` (≤63 chars), normalize to a slug (`lowercase`, replace any non-`[a-z0-9-]` run with `-`, trim leading/trailing `-`, truncate to 63 chars, prepend `c-` if first char is not a letter), store the normalized form as the display name. Reject only if normalization yields empty. The same algorithm sanitizes the project name for the default `<sanitized-project>-local-<n>` form (truncated to 40 chars for the project component).
- **Q5 (Naming parity for `generacy deploy`)** → **B**: `generacy deploy` accepts `--name` (flag parity), but default-name generation for non-launch paths is deferred. Deploy without `--name` falls back to current behavior (cluster id) in this milestone.

## User Stories

### US1: Launch a named cluster

**As a** developer working on a project with multiple Generacy clusters,
**I want** to give each cluster a meaningful name at `generacy launch` time (e.g. `acme-frontend-local`, `acme-staging-local`),
**So that** I can tell my clusters apart in the cloud dashboard and on my own machine, without juggling raw UUIDs.

**Acceptance Criteria**:
- [ ] `generacy launch --name <name>` accepts a human cluster name, normalizes it to a slug, and persists the normalized form into the scaffolded cluster identity.
- [ ] When `--name` is omitted, the CLI generates a default of the form `<sanitized-project>-local-<n>`, where `<n>` is the next free integer for that `(projectId, deploymentMode='local')` pair in `~/.generacy/clusters.json`.
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

### US5: `generacy deploy` accepts a name (flag parity)

**As a** developer provisioning a Generacy cluster on a BYO VM via `generacy deploy ssh://...`,
**I want** the same `--name <name>` flag accepted (and the normalized name persisted),
**So that** the CLI surface is consistent across `launch` and `deploy`, even before deploy gets its own default-name generator.

**Acceptance Criteria**:
- [ ] `generacy deploy --name <name>` accepts the flag, normalizes the name (same algorithm as `launch`), and persists it into the scaffolded cluster identity.
- [ ] When `--name` is omitted on `deploy`, the cluster falls back to current behavior (cluster id as display name); the `<sanitized-project>-<ssh|host>-<n>` default generator is **not** implemented in this milestone.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `deriveTunnelName(clusterId)` MUST be keyed on the cluster UUID (not projectId) so two clusters under one project yield distinct ≤20-char tunnel names. | P1 | Lives in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. Existing behavior already keys on cluster UUID per #608; verify and document. Q1→A confirms this stays UUID-derived. |
| FR-002 | The tunnel-name constraint (≤20 chars, lowercase `[a-z0-9-]`, must start with a letter) MUST be documented in code immediately adjacent to `deriveTunnelName`. | P1 | Comment + matching regex assertion in the helper. |
| FR-003 | `generacy launch` MUST accept an optional `--name <name>` flag, validated as non-empty (post-normalization). | P1 | Commander flag on `packages/generacy/src/cli/commands/launch/index.ts`. Per Q4→B: accept any non-empty input ≤63 chars, normalize to slug, reject only if normalized form is empty. |
| FR-003a | Name normalization MUST apply this algorithm: lowercase the input, replace any run of non-`[a-z0-9-]` characters with `-`, trim leading/trailing `-`, truncate to 63 chars, prepend `c-` if the first char is not a letter. | P1 | Shared helper consumed by both `--name` normalization and `<sanitized-project>` derivation. The same algorithm is used for project sanitization with a 40-char project component truncation. |
| FR-004 | When `--name` is omitted, the CLI MUST generate a default name of the form `<sanitized-project>-local-<n>`, where `<n>` is the next free integer for that project on the local machine. | P1 | Per Q2→B: uniqueness scope is `(projectId, deploymentMode='local')` over `~/.generacy/clusters.json`. Cloud/SSH clusters increment a separate sequence. Per Q4→B: `<sanitized-project>` uses the FR-003a normalization with the project component truncated to 40 chars. |
| FR-005 | The scaffolder MUST persist the (normalized) cluster name into the cluster identity files (`.generacy/cluster.json` and/or `.generacy/.env`) at creation time. | P1 | `packages/generacy/src/cli/commands/cluster/scaffolder.ts`. |
| FR-006 | The persisted cluster name MUST be immutable after creation — no CLI command in this scope mutates it. | P1 | Renaming is out of scope; see Out of Scope. |
| FR-007 | The orchestrator MUST surface both the cluster UUID and the display name in its relay registration / metadata payload. | P1 | `ClusterMetadataPayload`-style field in `packages/cluster-relay` and the relay-bridge `collectMetadata()`. |
| FR-008 | The display name MUST be decoupled from the derived tunnel name; renaming a cluster (if ever supported) must not change the tunnel name, and vice versa. | P1 | Distinct fields in the metadata payload. Per Q1→A, the tunnel name stays UUID-derived regardless of display name. |
| FR-009 | `generacy stop`, `generacy down`, and `generacy destroy` MUST unregister (or at least stop) the VS Code dev tunnel for the cluster being torn down. | P1 | Likely a control-plane lifecycle action invoked from CLI; pairs with #743. |
| FR-010 | Tunnel unregistration MUST be best-effort and idempotent — failure to release MUST NOT block container teardown but MUST surface a warning. | P2 | Match existing CLI lifecycle command UX (warn-and-continue). |
| FR-011 | The CLI MUST register the user-provided / generated cluster name in the local registry (`~/.generacy/clusters.json`) alongside the existing `clusterId`, and MUST record `deploymentMode` so default-name sequence generation can filter on it. | P1 | Schema update in `packages/generacy/src/registry/`. `deploymentMode` field is needed for the FR-004 lookup. |
| FR-012 | When two clusters' UUIDs would produce colliding `g-<uuid18>` tunnel names, the orchestrator MUST detect the collision at tunnel-start and emit a clear `cluster.vscode-tunnel` error event. | P2 | Probabilistically rare (18 hex chars), but cheap to guard. Per Q1→A, no in-code collision-resolution suffix is added — a clear error is the contract. |
| FR-013 | The cluster UUID MUST continue to be cloud-minted via the device-flow activation; the scaffolder MUST NOT pre-mint a UUID and advertise it. | P1 | Per Q3→A: CLI writes back whichever id cloud returns; activation flow unchanged. Default-name generation (FR-004) does not depend on the UUID and runs independently of activation. |
| FR-014 | `generacy deploy` MUST accept `--name <name>` with the same normalization rules as `launch` (FR-003 / FR-003a) and persist the normalized name into the scaffolded cluster identity. | P1 | Per Q5→B: flag parity only. Default-name generation for deploy (e.g. `<sanitized-project>-ssh-<n>`) is a follow-up issue. When omitted on deploy, the cluster falls back to current behavior (cluster id as display name). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cluster scaffolding accepts a name flag | 100% of `generacy launch --name foo` runs persist the normalized form of `foo` into `cluster.json` | Manual + integration test asserting file contents after scaffold |
| SC-002 | Default cluster names are unique per project on a single machine | Zero name collisions across N launches of the same project (N ≤ 10) | Integration test that runs `generacy launch` ten times for one project, asserts ten distinct names |
| SC-003 | Two clusters under the same project register distinct tunnel names | Both clusters' `cluster.vscode-tunnel` events show different tunnel names | E2E test against two scaffolded clusters with distinct UUIDs |
| SC-004 | Tunnel name conforms to VS Code constraint | 100% of derived tunnel names match `^[a-z][a-z0-9-]{0,19}$` | Property test on `deriveTunnelName` |
| SC-005 | Tunnel release on teardown | `generacy stop`/`down`/`destroy` cause the dev tunnel to no longer appear in `code tunnel list` within 30s | Manual verification + integration test on a test Microsoft account |
| SC-006 | Display name surfaces in cloud | The cloud dashboard (generacy-cloud#792) reads the display name from registration metadata without recomputing it | Cross-repo integration check |
| SC-007 | Name normalization is consistent across `launch` and `deploy` | Same input `--name` value produces the same normalized output on both commands | Unit test against the shared normalization helper |
| SC-008 | Default-name sequence is scoped per `(projectId, deploymentMode)` | Mixing a local launch and a cloud/SSH cluster under one project does not perturb either sequence | Integration test that interleaves entries with different `deploymentMode` values and asserts each sequence is contiguous |

## Assumptions

- The cluster UUID is minted by cloud during device-flow activation (Q3→A) and is stable for the lifetime of the cluster (no UUID churn).
- VS Code's tunnel-name constraint (≤20 chars, lowercase `[a-z0-9-]`, starts with a letter) holds — if Microsoft relaxes it, the helper still works.
- The local registry (`~/.generacy/clusters.json`) is the source of truth for default-name uniqueness; cloud-side uniqueness is handled by generacy-cloud#792.
- `code tunnel unregister` (or equivalent) is available in the orchestrator image and can be invoked by the control-plane on lifecycle action.
- The cluster name does not need to be modifiable post-creation in this milestone (rename is a separate feature if needed).
- The local registry schema can be extended with a `deploymentMode` field (FR-011) without breaking existing entries; entries missing this field are treated as `'local'` for backward compatibility.

## Out of Scope

- **Cluster rename** after creation (display name is immutable in this milestone).
- **Cloud-side data model / UI** for multi-cluster — covered by generacy-cloud#792.
- **Interim clobber guard** in the cloud — covered by generacy-cloud#791.
- **Cloud stop/start lifecycle** — covered by generacy-cloud#789.
- **Migrating existing single-cluster projects** to the multi-cluster model (data migration is the cloud's responsibility; CLI just writes the new fields going forward).
- **Choosing between UUID-derived vs name-derived tunnel names** — resolved by Q1→A (keep UUID-derived).
- **Default-name generation for `generacy deploy`** (e.g. `<sanitized-project>-ssh-<n>` / `<sanitized-project>-<host>-<n>`) — deferred per Q5→B; follow-up issue.
- **CLI-minted cluster UUIDs** with cloud confirmation/conflict handling — rejected per Q3→A.

---

*Generated by speckit*
