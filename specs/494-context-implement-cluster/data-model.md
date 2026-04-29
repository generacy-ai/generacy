# Data Model: CLI Cluster Lifecycle Commands (#494)

## Core Types

### ClusterContext

Resolved by `getClusterContext(cwd)`. This is the primary data object passed to all commands.

```typescript
/** Resolved cluster context from .generacy/ directory */
export interface ClusterContext {
  /** Absolute path to the project root (parent of .generacy/) */
  projectRoot: string;
  /** Absolute path to .generacy/ directory */
  generacyDir: string;
  /** Absolute path to .generacy/docker-compose.yml */
  composePath: string;
  /** Parsed .generacy/cluster.yaml */
  clusterConfig: ClusterYaml;
  /** Parsed .generacy/cluster.json (null if not yet activated) */
  clusterIdentity: ClusterJson | null;
  /** Effective project name for docker compose (clusterId or dirname fallback) */
  projectName: string;
}
```

### ClusterYaml

Project-level config at `.generacy/cluster.yaml`.

```typescript
export const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['standard', 'microservices']).default('standard'),
});

export type ClusterYaml = z.infer<typeof ClusterYamlSchema>;
```

### ClusterJson

Runtime identity at `.generacy/cluster.json`. Written by activation (orchestrator package). Read-only for CLI.

```typescript
// Re-use from @generacy-ai/orchestrator or define locally
export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

export type ClusterJson = z.infer<typeof ClusterJsonSchema>;
```

### RegistryEntry

One entry in `~/.generacy/clusters.json`.

```typescript
export const RegistryEntrySchema = z.object({
  /** Cluster ID from activation (or null if pre-activation) */
  clusterId: z.string().nullable(),
  /** Human-readable name (directory basename) */
  name: z.string(),
  /** Absolute path to project root */
  path: z.string(),
  /** Absolute path to docker-compose.yml */
  composePath: z.string(),
  /** Cluster variant */
  variant: z.enum(['standard', 'microservices']).default('standard'),
  /** Release channel */
  channel: z.enum(['stable', 'preview']).default('stable'),
  /** Cloud URL (from cluster.json, or null) */
  cloudUrl: z.string().nullable(),
  /** ISO timestamp of last successful `up` or `update` */
  lastSeen: z.string().datetime(),
  /** ISO timestamp of first registration */
  createdAt: z.string().datetime(),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
```

### Registry

The full registry file.

```typescript
export const RegistrySchema = z.array(RegistryEntrySchema);

export type Registry = z.infer<typeof RegistrySchema>;
```

## Status Output Schema

### ClusterStatus

Returned by the `status` command, combines registry data with live Docker state.

```typescript
export const ContainerStateSchema = z.enum([
  'running',
  'stopped',
  'exited',
  'paused',
  'restarting',
  'dead',
  'created',
]);

export const ServiceStatusSchema = z.object({
  name: z.string(),
  state: ContainerStateSchema,
  status: z.string(),  // e.g., "Up 2 hours", "Exited (0) 5 minutes ago"
});

export const ClusterStatusSchema = z.object({
  clusterId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  variant: z.string(),
  channel: z.string(),
  /** Overall cluster state derived from services */
  state: z.enum(['running', 'stopped', 'partial', 'missing']),
  services: z.array(ServiceStatusSchema),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;
```

The `--json` flag outputs `ClusterStatus[]`.

### State Derivation Rules

| Condition | Derived State |
|-----------|---------------|
| All services running | `running` |
| All services stopped/exited | `stopped` |
| Mix of running and stopped | `partial` |
| Compose project not found / no containers | `missing` |

## Command Option Types

```typescript
export interface DownOptions {
  volumes: boolean;  // --volumes flag, default false
}

export interface DestroyOptions {
  yes: boolean;  // --yes flag, skip confirmation
}

export interface StatusOptions {
  json: boolean;  // --json flag, output as JSON
}
```

## Helper Function Signatures

```typescript
/** Walk upward from cwd to find .generacy/cluster.yaml */
function getClusterContext(cwd?: string): ClusterContext;

/** Build [--project-name, --file] args for docker compose */
function dockerComposeArgs(ctx: ClusterContext): string[];

/** Execute a docker compose command, return ExecResult */
function runCompose(ctx: ClusterContext, subcommand: string[]): ExecResult;

/** Check Docker/Compose availability, throw with user-friendly message */
function ensureDocker(): void;

/** Read registry from ~/.generacy/clusters.json */
function readRegistry(): Registry;

/** Write registry atomically */
function writeRegistry(registry: Registry): void;

/** Update or insert a registry entry by path */
function upsertRegistryEntry(ctx: ClusterContext): void;

/** Remove a registry entry by path */
function removeRegistryEntry(projectPath: string): void;

/** Query container status for a cluster via docker compose ps */
function getClusterServices(ctx: ClusterContext): ServiceStatus[];
```

## File Relationships

```
~/.generacy/
└── clusters.json              ← Registry (array of RegistryEntry)

<project-root>/
└── .generacy/
    ├── cluster.yaml           ← ClusterYaml (project config)
    ├── cluster.json           ← ClusterJson (activation identity)
    └── docker-compose.yml     ← Docker Compose file (generated by launch)
```

## Validation Rules

| Field | Rule |
|-------|------|
| `cluster_id` | Non-empty string, typically UUID format |
| `path` | Absolute path, must exist on disk for live queries |
| `composePath` | Absolute path, must point to valid YAML |
| `channel` | `stable` or `preview` only |
| `variant` | `standard` or `microservices` only |
| `lastSeen` | Valid ISO 8601 datetime |
| `createdAt` | Valid ISO 8601 datetime, immutable after creation |
