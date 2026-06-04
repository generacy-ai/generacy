# Data Model: Pre-Approved Device Code Redemption

**Issue**: [#739](https://github.com/generacy-ai/generacy/issues/739)
**Branch**: `739-summary-managed-cloud-cluster`

## Overview

This change introduces no new persisted entities. It threads a single optional string (`preApprovedDeviceCode`) through three TypeScript types and one env var. All persisted artifacts (`/var/lib/generacy/cluster-api-key`, `/var/lib/generacy/cluster.json`) are written by the existing approved-path code and are unchanged.

## Type Additions

### 1. `LaunchConfigSchema` — cloud → CLI wire format

**File**: `packages/generacy/src/cli/commands/launch/types.ts`

```typescript
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  channel: z.enum(['stable', 'preview']).optional(),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    primaryBranch: z.string().min(1).optional(),
    dev: z.array(z.string()).optional(),
    clone: z.array(z.string()).optional(),
  }),
  cloud: CloudUrlsSchema.optional(),
  registryCredentials: z.array(RegistryCredentialSchema).optional(),
  tierCap: z.number().int().min(1).optional(),
  preApprovedDeviceCode: z.string().min(1).optional(),    // ← NEW
});
```

**Validation rules**:
- `.optional()` — cloud may or may not send it (older clouds, local dev with `GENERACY_LAUNCH_STUB=1`).
- `.min(1)` — must not be empty when present. No upper bound (cloud-controlled format).
- No regex check on shape — the value is opaque to the CLI (only the cloud's `/device-code/poll` endpoint knows the format).

### 2. `ScaffoldEnvInput` — scaffolder input

**File**: `packages/generacy/src/cli/commands/cluster/scaffolder.ts`

```typescript
export interface ScaffoldEnvInput {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  projectName: string;
  repoUrl?: string;
  repoBranch?: string;
  channel?: 'stable' | 'preview';
  workers?: number;
  orchestratorPort?: number;
  cloud?: { apiUrl: string; relayUrl: string };
  preApprovedDeviceCode?: string;                          // ← NEW
}
```

**Validation rules**: TypeScript-only (interface, not Zod). Validation upstream at `LaunchConfigSchema`. Empty string is treated as absent (no env line emitted) — `scaffoldEnvFile` checks truthiness, not `!== undefined`.

## Env Var

### `GENERACY_PRE_APPROVED_DEVICE_CODE`

**Type**: opaque string (RFC 8628 device code)
**Source**:
- Cloud-managed deploy: written into `.env` via generacy-cloud's `buildLaunchConfig` → cloud-init `user_data` (companion repo work).
- CLI-managed deploy (`generacy launch` / `deploy`): written into `.env` via `scaffoldEnvFile` from `LaunchConfig.preApprovedDeviceCode`.
- Manual override: operator `export`s before running compose.

**Consumer**: `packages/orchestrator/src/activation/index.ts` `activate()`. Read once at activation time. Deleted from `process.env` after successful redemption (defense-in-depth per clarification Q1).

**Lifetime**:
- On disk (`.env`): persists until the container/cluster is destroyed.
- In `process.env`: only until `activate()` succeeds (then `delete`d).
- Server-side: single-use, ~10 min TTL (cloud-enforced).

**Sensitivity**: High — bearer credential. Treated like an API key:
- Never logged.
- Never reflected in `/health` or any other endpoint response.
- Never emitted on any relay channel.

## Persistence (Unchanged)

### `/var/lib/generacy/cluster-api-key`

File mode 0600, written atomically (temp + rename). Content: the cluster API key string returned by `pollForApproval`. **Written identically in both the interactive and pre-approved code paths** — the new branch calls the existing `writeKeyFile()`.

### `/var/lib/generacy/cluster.json`

JSON, written atomically. Schema (unchanged):

```typescript
export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});
```

**Written identically in both paths.** No new fields. The pre-approved branch populates these from `pollResult.cluster_*` / `pollResult.cloud_url` exactly like the interactive branch (`activation/index.ts:104-110`).

## Relationships

```
Cloud preApproveActivationCode
        │
        ▼
LaunchConfig.preApprovedDeviceCode  ──►  scaffoldEnvFile (CLI path)
        │                                      │
        │                                      ▼
        │                              .env line written
        │                                      │
        ▼                                      ▼
cloud-init user_data (managed path) ─► .env line written (in-container)
                                              │
                                              ▼
                                  process.env.GENERACY_PRE_APPROVED_DEVICE_CODE
                                              │
                                              ▼
                                       activate()  ─►  pollForApproval(deviceCode)
                                              │             │
                                              │             ▼
                                              │     /api/clusters/device-code/poll
                                              │             │
                                              │             ▼
                                              │      { status: 'approved', cluster_api_key, … }
                                              │             │
                                              ▼             ▼
                                  delete process.env  +  writeKeyFile + writeClusterJson
```

## Migration Notes

- **No data migration.** No persisted artifacts change schema.
- **No backwards-compatibility shim.** The env var is greenfield (no prior reader).
- Older clusters without `preApprovedDeviceCode` in `LaunchConfig` continue to use the interactive flow on first boot (unchanged behavior).
- Restarted clusters that already have a key file at `/var/lib/generacy/cluster-api-key` skip activation entirely (existing behavior; pre-approved branch is not reached).
