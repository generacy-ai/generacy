# Implementation Plan: Per-cluster tunnel name + identity for multi-cluster

**Feature**: Cluster/CLI/orchestrator-side support for multiple clusters per project with user-named clusters
**Branch**: `744-summary-cluster-cli`
**Status**: Complete
**Issue**: [generacy-ai/generacy#744](https://github.com/generacy-ai/generacy/issues/744)

## Summary

Add per-cluster display names and ensure VS Code dev tunnels stay unique when a single project has multiple clusters. Touches three layers of the codebase that already exist:

1. **CLI scaffolder + commands** (`packages/generacy`) — `launch` and `deploy` accept a new `--name` flag; the scaffolder normalizes and persists the name; the local registry (`~/.generacy/clusters.json`) grows a `displayName` and `deploymentMode` so the default `<sanitized-project>-local-<n>` generator can count only local clusters.
2. **Orchestrator + relay** (`packages/orchestrator`, `packages/cluster-relay`) — the cluster identity surfaced through `ClusterMetadataPayload` / `ClusterMetadata` gains a `displayName` field, sourced from a new `GENERACY_CLUSTER_NAME` env var written into `.generacy/.env`.
3. **Control-plane VS Code tunnel** (`packages/control-plane`) — `deriveTunnelName` re-keyed on `GENERACY_CLUSTER_ID` (was `GENERACY_PROJECT_ID` per #618), with a comment explaining why multi-cluster forces per-cluster uniqueness; `generacy stop`/`down`/`destroy` invoke `vscode-tunnel-stop` (and add a new `vscode-tunnel-unregister` action) before tearing down containers.

Clarifications already resolved (Batch 1, see `clarifications.md`): UUID-derived tunnel names (Q1→A), per `(projectId, deploymentMode='local')` uniqueness scope (Q2→B), cloud-minted cluster UUIDs (Q3→A), permissive-+-normalize naming algorithm (Q4→B), `--name` flag parity for `deploy` without a default generator (Q5→B).

## Technical Context

- **Language / runtime**: TypeScript, Node.js ≥22, ESM.
- **CLI**: `@generacy-ai/generacy` (`commander`, `@clack/prompts`, `pino`, `zod`).
- **Orchestrator**: Fastify-based HTTP server + cluster-relay WebSocket client.
- **Control-plane**: `node:http` over Unix socket; manages code-server and `code tunnel` child processes.
- **Persistence**:
  - Per-project: `.generacy/cluster.json` (snake_case) and `.generacy/.env` (`GENERACY_*` env vars consumed by orchestrator + control-plane).
  - Per-host: `~/.generacy/clusters.json` (validated by `RegistryEntrySchema` in `cli/commands/cluster/registry.ts`).
- **No new dependencies** — uses existing `zod`, `commander`, `node:fs`, `node:http`, `node:child_process`.
- **Companions** (out of scope but coupled to wire format): generacy-cloud#792 (data model + UI), #791 (interim clobber guard), #789 (cloud stop/start).

## Existing State (what we change vs. what is already in place)

| Component | Path | Current state | Change needed |
|---|---|---|---|
| Tunnel name derivation | `packages/control-plane/src/services/vscode-tunnel-manager.ts` (`loadOptionsFromEnv`, `deriveTunnelName`) | Already exports `deriveTunnelName(clusterId)`; `loadOptionsFromEnv` passes `GENERACY_PROJECT_ID` (per #618) | Revert source to `GENERACY_CLUSTER_ID` + update comment for multi-cluster (FR-001/FR-002) |
| Tunnel lifecycle in CLI | `packages/generacy/src/cli/commands/{stop,down,destroy}/index.ts` | Only call `docker compose stop/down/down -v`; no tunnel teardown | Invoke `vscode-tunnel-stop` (and new `vscode-tunnel-unregister` for destroy) before compose teardown (FR-009/FR-010) |
| `vscode-tunnel-unregister` action | `packages/control-plane/src/{schemas.ts,routes/lifecycle.ts,services/vscode-tunnel-manager.ts}` | `LifecycleActionSchema` has `vscode-tunnel-stop`; no unregister | Add new enum entry + handler that runs `code tunnel unregister --name <name>` |
| `--name` flag | `packages/generacy/src/cli/commands/{launch,deploy}/index.ts` | Neither command exposes `--name` | Add `commander` `.option('--name <name>', ...)` on both; thread through to scaffolder (FR-003, FR-014) |
| Name normalization | (new) `packages/generacy/src/cli/commands/cluster/name-normalize.ts` | n/a | New shared helper for `<project>` and `<name>` sanitization (FR-003a) |
| Default-name generator | (new) `packages/generacy/src/cli/commands/cluster/default-name.ts` | n/a | Reads registry, filters by `projectId + deploymentMode='local'`, returns `<sanitized-project>-local-<n>` (FR-004) |
| Scaffolder accepts `displayName` | `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (`scaffoldClusterJson`, `scaffoldEnvFile`) | Writes `cluster.json` w/ `{cluster_id, project_id, org_id, cloud_url}`; `.env` lacks `GENERACY_CLUSTER_NAME` | Add `display_name` to `cluster.json`; add `GENERACY_CLUSTER_NAME=<name>` to `.env` (FR-005) |
| Registry schema | `packages/generacy/src/cli/commands/cluster/registry.ts` (`RegistryEntrySchema`) | Has `name: z.string()` field but it's set to `projectName` (launch) / `basename` (upsert) | Add `displayName: z.string()` + `deploymentMode: z.enum(['local','cloud']).optional()`; treat missing `deploymentMode` as `'local'` (FR-011) |
| Orchestrator env loader | `packages/orchestrator/src/config/loader.ts` | Reads `GENERACY_CLUSTER_ID`, `GENERACY_PROJECT_ID`, etc. | Read new `GENERACY_CLUSTER_NAME` (optional) and thread into relay-bridge metadata |
| Relay metadata payload | `packages/orchestrator/src/types/relay.ts` (`ClusterMetadataPayload`), `packages/cluster-relay/src/messages.ts` (`ClusterMetadata`, `ClusterMetadataSchema`) | No `displayName` / `clusterId` field | Add optional `displayName?: string` + optional `clusterId?: string`; thread through `collectMetadata` in both packages (FR-007/FR-008) |
| Tunnel-collision guard | `packages/control-plane/src/services/vscode-tunnel-manager.ts` (`handleStdoutLine`) | Already records `actualTunnelName` from `vscode.dev/tunnel/<x>` URL | Emit `cluster.vscode-tunnel` error event when `actualTunnelName` differs from the requested name (FR-012) |

## Project Structure

New files (kept small, single-purpose):

```
packages/generacy/src/cli/commands/cluster/
├─ name-normalize.ts          # NEW — normalizeClusterName(input), sanitizeProjectComponent(input)
├─ default-name.ts            # NEW — generateDefaultName(projectId, projectName)
├─ __tests__/
│  ├─ name-normalize.test.ts  # NEW — property/edge-case tests for normalization
│  └─ default-name.test.ts    # NEW — registry-driven sequence tests
```

Modified files:

```
packages/generacy/src/cli/commands/
├─ launch/
│  ├─ index.ts                # +--name flag; default-name fallback; pass to scaffolder
│  ├─ registry.ts             # Use displayName + deploymentMode='local'
│  └─ types.ts                # LaunchOptions: + name?: string
├─ deploy/
│  ├─ index.ts                # +--name flag; passthrough only (no default generator)
│  ├─ types.ts                # DeployOptions: + name?: string
│  └─ scaffolder.ts           # Pass displayName to shared scaffolder; pass deploymentMode='cloud'
├─ cluster/
│  ├─ scaffolder.ts           # ScaffoldClusterJsonInput + display_name; ScaffoldEnvInput + clusterName
│  ├─ registry.ts             # RegistryEntrySchema: + displayName, + deploymentMode
│  └─ context.ts              # Read display_name from cluster.json (for tunnel-unregister flow)
├─ stop/index.ts              # Call vscode-tunnel-stop via control-plane socket before compose stop
├─ down/index.ts              # Same as stop, plus pass --volumes flag through
└─ destroy/index.ts           # Call vscode-tunnel-unregister, then compose down -v + cleanup

packages/control-plane/src/
├─ schemas.ts                 # LifecycleActionSchema: + 'vscode-tunnel-unregister'
├─ routes/lifecycle.ts        # New handler branch invoking VsCodeTunnelManager.unregister()
└─ services/vscode-tunnel-manager.ts
                              # deriveTunnelName comment update; loadOptionsFromEnv ← GENERACY_CLUSTER_ID;
                              # add unregister() method spawning `code tunnel unregister --name <x>`;
                              # collision guard emitting cluster.vscode-tunnel error

packages/orchestrator/src/
├─ config/loader.ts           # Read GENERACY_CLUSTER_NAME (optional)
├─ types/relay.ts             # ClusterMetadataPayload: + displayName?, + clusterId?
└─ services/relay-bridge.ts   # collectMetadata threads displayName from config

packages/cluster-relay/src/messages.ts
                              # ClusterMetadata + ClusterMetadataSchema: + displayName?, + clusterId?
```

## Constitution Check

No `.specify/memory/constitution.md` file exists in the repo. Skipping formal constitution check.

Project-level discipline gates worth noting:
- **No new runtime deps** added — all logic uses `node:*` and existing `zod`/`commander`.
- **Backward compatibility**: registry entries missing `deploymentMode` are treated as `'local'`; `displayName` falls back to existing `name` or `clusterId` if absent. No migration required.
- **Wire format change** (`ClusterMetadata.displayName`) is purely additive — cloud receivers tolerating extra/missing fields are unaffected, and Zod `.optional()` keeps both sides forward/backward compatible.

## Key Technical Decisions

1. **Tunnel name reverts to cluster-UUID source** but keeps the existing `deriveTunnelName(clusterId)` signature. The pure helper is already correct; only the env var read in `loadOptionsFromEnv` flips back. The comment is updated to record why multi-cluster forces this back, and what changed since #618 (cloud now preserves `vscodeTunnelName` per cluster, so the stability concern that motivated #618 is resolved by cluster-scoped persistence, not by reusing the project id).

2. **Display name lives in three places** (cluster.json, .env, registry) with `cluster.json` as the on-disk source of truth, `.env` as the runtime delivery vehicle to the orchestrator container (via `GENERACY_CLUSTER_NAME`), and the registry entry mirroring it for `generacy status` and the default-name generator.

3. **Default-name generator runs CLI-side before activation** (Q3→A). The registry is keyed on the `projectId` returned by the cloud `LaunchConfig` fetch, which happens before the cluster id is minted. This decouples default-name generation from the device-flow.

4. **`destroy` adds a new `vscode-tunnel-unregister` lifecycle action** distinct from `vscode-tunnel-stop`. `stop`/`down` should pause/disconnect the tunnel (containers can come back); `destroy` must release the Microsoft tunnel-service name so the cluster is fully reclaimable.

5. **Collision guard is observational, not corrective** (Q1→A). `g-<uuid18>` collisions in 18 hex chars are vanishingly rare (~2^-72 per pair). The control-plane already captures `actualTunnelName` from the registered URL; we extend the existing path to emit a clear `cluster.vscode-tunnel` error event when requested ≠ actual.

6. **Re-use existing CLI socket dispatching**. The CLI doesn't talk to the control-plane directly today; it talks to compose. For the lifecycle invocations we go through the orchestrator's `/control-plane/lifecycle/:action` route (already wired in `server.ts` per `#574`), keeping the CLI's surface area unchanged (still `docker compose exec ...` patterns).

## Risks & Mitigations

- **Risk**: Reverting tunnel source to cluster id resurrects the #618 desync. **Mitigation**: cloud-side persistence is per-cluster now (cloud#792 + #563 merge:true). Document the dependency in the helper comment.
- **Risk**: `code tunnel unregister` blocks on network; CLI teardown hangs. **Mitigation**: FR-010 makes unregistration best-effort with a 10s timeout — failure logs a warning and proceeds to compose teardown.
- **Risk**: Existing registry entries without `displayName` break readers. **Mitigation**: schema makes it optional; readers fall back to `name` → `clusterId`.
- **Risk**: Two parallel `generacy launch` invocations race on the default-name sequence. **Mitigation**: registry write is `tmp+rename` atomic; sequence generation reads-then-writes the registry under a single I/O cycle. Worst case: two clusters land with `-local-3` and `-local-3` — accept this (rare, manually resolvable) rather than introducing a lock file.

## Out of Scope (deferred)

Tracked in the spec's "Out of Scope" — most importantly cluster rename, cloud-side schema (#792), interim clobber guard (#791), cloud stop/start (#789), default-name generation for `generacy deploy`, and CLI-minted cluster UUIDs.

## Next Step

Run `/speckit:tasks` to generate the per-file task list.
