# Data Model

## On-disk: `.generacy/cluster.json` (per cluster)

Snake-case JSON, written by `scaffoldClusterJson()` at creation time. Source of truth for cluster identity on the local host (or remote host for `deploy`).

```jsonc
{
  "cluster_id": "9e5c8a0d-755e-40b3-b0c3-43e849f0bb90",  // cloud-minted UUID
  "project_id": "proj_abc123",                            // cloud-minted, stable per project
  "org_id": "org_xyz789",
  "cloud_url": "https://api.generacy.ai",
  "display_name": "acme-frontend-local-1",                // NEW — normalized cluster display name
  "activated_at": "2026-06-03T14:22:00.000Z"              // optional, container-side
}
```

Existing entries without `display_name` are read as having `display_name === undefined`; consumers fall back to `cluster_id`.

## On-disk: `.generacy/.env` (per cluster, sourced by docker compose)

Adds one line:

```
GENERACY_CLUSTER_NAME=acme-frontend-local-1
```

Consumed by:
- Orchestrator `config/loader.ts` → propagates to relay metadata.
- (No control-plane consumer required; tunnel name still derives from `GENERACY_CLUSTER_ID`.)

## On-disk: `~/.generacy/clusters.json` (per host)

Validated by `RegistryEntrySchema` in `packages/generacy/src/cli/commands/cluster/registry.ts`. Schema extension:

```typescript
export const RegistryEntrySchema = z.object({
  clusterId: z.string().nullable(),
  name: z.string(),                              // existing — keeps original semantics for compat
  displayName: z.string().optional(),            // NEW — normalized cluster display name
  projectId: z.string().optional(),              // NEW — enables (projectId, mode) sequencing
  deploymentMode: z.enum(['local', 'cloud']).optional(),  // NEW — 'cloud' for SSH deploys, 'local' for launch
  path: z.string(),
  composePath: z.string(),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  channel: z.enum(['stable', 'preview']).default('stable'),
  cloudUrl: z.string().nullable(),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
  managementEndpoint: z.string().optional(),
});
```

**Field semantics**:
- `name` — unchanged for backward compat. Existing code may still read it (it currently holds the project name for launch, `basename(projectRoot)` for upserts).
- `displayName` — the user-provided or auto-generated cluster name, after normalization. New writers populate it; old entries without it use `name` then `clusterId` as fallback.
- `projectId` — required for new entries written by `launch`/`deploy`. Old entries without it are excluded from default-name sequence counts.
- `deploymentMode` — explicit on new writes. Missing values are treated as `'local'` for backward compatibility.

## Wire: cluster-relay `ClusterMetadata` (orchestrator → cloud)

Both the TypeScript interface in `packages/cluster-relay/src/messages.ts` and its Zod schema gain two optional fields:

```typescript
export interface ClusterMetadata {
  workers: number;
  activeWorkflows: number;
  channel: 'preview' | 'stable';
  orchestratorVersion: string;
  gitRemotes: GitRemote[];
  uptime: number;
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  displayName?: string;        // NEW
  clusterId?: string;          // NEW (was carried in handshake activation; explicit here for #792)
}

export const ClusterMetadataSchema = z.object({
  workers: z.number(),
  activeWorkflows: z.number(),
  channel: z.enum(['preview', 'stable']),
  orchestratorVersion: z.string(),
  gitRemotes: z.array(GitRemoteSchema),
  uptime: z.number(),
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
});
```

Note: `codeServerReady` / `controlPlaneReady` are already in the TS interface but not yet in the Zod schema (existing inconsistency; not modified here). The orchestrator's own `ClusterMetadataPayload` in `packages/orchestrator/src/types/relay.ts` gets the same two new optional fields.

## Wire: control-plane lifecycle action

`LifecycleActionSchema` (in `packages/control-plane/src/schemas.ts`) gains one entry:

```typescript
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'prepare-workspace',
  'stop',
  'vscode-tunnel-start',
  'vscode-tunnel-stop',
  'vscode-tunnel-unregister',  // NEW
  'worker-scale',
]);
```

Handler runs `code tunnel unregister --name <tunnelName>` via `VsCodeTunnelManager.unregister()`, returns `{accepted: true, action: 'vscode-tunnel-unregister'}`. Failure surfaces as `cluster.vscode-tunnel` error event (not a 5xx), per FR-010.

## Entity relationships

```
project (cloud) ──1───────────n── cluster
                                    │
                                    ├── cluster_id (UUID, cloud-minted)
                                    ├── display_name (CLI-normalized, immutable)
                                    ├── tunnel_name = `g-${cluster_id.replace(/-/g,'').slice(0,18)}`
                                    └── deployment_mode ∈ {local, cloud}

registry (per-host) ── m to n ── cluster   (a cluster lives in exactly one registry; m hosts × n clusters)
```

`tunnel_name` is *derived*, never persisted as a field of cluster identity in this milestone — both display name and tunnel name are decoupled per FR-008. The cloud-side `vscodeTunnelName` is the *actually-registered* name (which may differ from the requested one when collision falls back to a random suffix, per #743); this is collected from the parsed tunnel URL and reported through `cluster.vscode-tunnel` events.

## Validation Rules

| Field | Rule | Source |
|---|---|---|
| `--name` input | non-empty after normalization (FR-003) | `normalizeClusterName` |
| Normalized name | matches `/^[a-z][a-z0-9-]{0,62}$/` | `normalizeClusterName` post-condition |
| Project component in default name | matches `/^[a-z][a-z0-9-]{0,39}$/` | `sanitizeProjectComponent` post-condition |
| `<n>` in default name | smallest positive integer not in taken set | `generateDefaultName` |
| `display_name` in cluster.json | preserved exactly as written | scaffolder |
| `displayName` in registry | matches normalized form | registry validator |
| Tunnel name (`g-<uuid18>`) | matches `/^[a-z][a-z0-9-]{0,19}$/` | `deriveTunnelName` post-condition (assert in code, FR-002) |
