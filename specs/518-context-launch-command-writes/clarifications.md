# Clarifications — #518 Reconcile launch CLI schemas with lifecycle commands

## Batch 1 — 2026-04-30

### Q1: `activated_at` source value
**Context**: The lifecycle `ClusterJsonSchema` requires `activated_at: z.string().datetime()`, but at launch-scaffold time the cluster hasn't completed device-flow activation yet. The cloud `LaunchConfig` doesn't include this field either.
**Question**: What value should `activated_at` be set to in `cluster.json` when the launch scaffolder writes the file — the current timestamp (scaffold time), or should the field be made optional so it's filled in later after actual activation?
**Options**:
- A: Use scaffold timestamp as `activated_at` (pragmatic — lets lifecycle commands parse immediately)
- B: Make `activated_at` optional in the lifecycle schema and omit it until real activation completes
- C: Write a sentinel value (e.g. empty string) and update post-activation

**Answer**: *Pending*

### Q2: `orgId` availability from cloud API
**Context**: FR-002 requires adding `orgId` to `LaunchConfigSchema`, and the spec assumes the cloud endpoint will be updated to return it (companion cloud issue). If the cloud change isn't deployed yet, launch will fail Zod validation on every API call.
**Question**: Should `orgId` be required or optional in `LaunchConfigSchema`, and if optional, what should the scaffolder write for `org_id` in `cluster.json`?
**Options**:
- A: Make `orgId` required — launch fails if cloud doesn't provide it (strict, forces deploy ordering)
- B: Make `orgId` optional — write `org_id: ""` or omit it, and make lifecycle schema's `org_id` optional too (Recommended)
- C: Make `orgId` optional in LaunchConfig but required in cluster.json with a placeholder like `"unknown"`

**Answer**: *Pending*

### Q3: `cluster.yaml` schema mismatch
**Context**: The spec focuses on `cluster.json`, but `cluster.yaml` is also broken. Launch writes `{variant, imageTag, cloudUrl, ports}` while the lifecycle reader (`ClusterYamlSchema`) expects `{channel, workers, variant}`. Zod will strip the extra fields and apply defaults for missing ones, so `up` won't crash, but the written config loses `imageTag`/`cloudUrl`/`ports` on round-trip.
**Question**: Should this PR also fix the `cluster.yaml` schema mismatch, or is that a separate issue?
**Options**:
- A: Fix in this PR — add `imageTag`, `cloudUrl`, `ports` to `ClusterYamlSchema` (or move them elsewhere)
- B: Separate issue — `cluster.yaml` round-trip loss is non-blocking since Zod applies defaults
- C: Fix in this PR by removing extra fields from launch's cluster.yaml and relying on docker-compose.yml for those values

**Answer**: *Pending*

### Q4: Registry `variant`/`channel` enum validation
**Context**: The lifecycle `RegistryEntrySchema` uses strict enums (`variant: z.enum(['standard', 'microservices'])`, `channel: z.enum(['stable', 'preview'])`). Launch passes `config.variant` from the cloud API as a free string and hardcodes `channel: 'stable'`. If the cloud returns a variant not in the enum (e.g. `'custom'`), registry writes will fail Zod validation.
**Question**: Should the enum be the source of truth (reject unknown values), or should the schema be relaxed to accept any string with the enum as a default?
**Options**:
- A: Keep strict enums — cloud must return valid values; fail-fast on mismatch (Recommended)
- B: Use `z.string().default('standard')` — accept anything, lose validation
- C: Use `z.enum([...]).or(z.string())` — accept known values with type safety, allow unknown as fallback

**Answer**: *Pending*

### Q5: Registry `clusterId` nullability
**Context**: The lifecycle `RegistryEntrySchema` has `clusterId: z.string().nullable()` (supporting pre-activation clusters with no ID). Launch always has a `clusterId` from the cloud config and uses `clusterId: string` (non-nullable). FR-004 says to define the registry schema once and import it everywhere.
**Question**: When unifying the registry schema, should `clusterId` remain nullable (lifecycle's current behavior) or become required (launch's assumption)?
**Options**:
- A: Keep nullable — supports both pre-activation (`init`) and post-activation (`launch`) paths (Recommended)
- B: Make required — pre-activation clusters use a generated placeholder ID

**Answer**: *Pending*
