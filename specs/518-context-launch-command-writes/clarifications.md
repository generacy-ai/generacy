# Clarifications — #518 Reconcile launch CLI schemas with lifecycle commands

## Batch 1 — 2026-04-30

### Q1: `activated_at` source value
**Context**: The lifecycle `ClusterJsonSchema` requires `activated_at: z.string().datetime()`, but at launch-scaffold time the cluster hasn't completed device-flow activation yet. The cloud `LaunchConfig` doesn't include this field either.
**Question**: What value should `activated_at` be set to in `cluster.json` when the launch scaffolder writes the file — the current timestamp (scaffold time), or should the field be made optional so it's filled in later after actual activation?
**Options**:
- A: Use scaffold timestamp as `activated_at` (pragmatic — lets lifecycle commands parse immediately)
- B: Make `activated_at` optional in the lifecycle schema and omit it until real activation completes
- C: Write a sentinel value (e.g. empty string) and update post-activation

**Answer**: B — Make `activated_at` optional in the lifecycle schema; launch omits it. The field semantically means "when device-flow activation completed," and at launch-scaffold time activation hasn't happened yet. Lifecycle commands shouldn't depend on it for anything critical; the registry's `createdAt` covers "when was this cluster set up." Activation time gets populated cluster-side (`/var/lib/generacy/cluster.json` per #492's activation flow) and is purely informational for host-side commands.

### Q2: `orgId` availability from cloud API
**Context**: FR-002 requires adding `orgId` to `LaunchConfigSchema`, and the spec assumes the cloud endpoint will be updated to return it (companion cloud issue). If the cloud change isn't deployed yet, launch will fail Zod validation on every API call.
**Question**: Should `orgId` be required or optional in `LaunchConfigSchema`, and if optional, what should the scaffolder write for `org_id` in `cluster.json`?
**Options**:
- A: Make `orgId` required — launch fails if cloud doesn't provide it (strict, forces deploy ordering)
- B: Make `orgId` optional — write `org_id: ""` or omit it, and make lifecycle schema's `org_id` optional too (Recommended)
- C: Make `orgId` optional in LaunchConfig but required in cluster.json with a placeholder like `"unknown"`

**Answer**: A — Make `orgId` required in `LaunchConfigSchema`. Both #518 and #474 (companion cloud issue) are `v1.5/blocker` and must ship together. Strict typing forces deploy ordering and surfaces a clean error if the cloud is stale. Loose typing lets broken state propagate silently into `cluster.json`.

### Q3: `cluster.yaml` schema mismatch
**Context**: The spec focuses on `cluster.json`, but `cluster.yaml` is also broken. Launch writes `{variant, imageTag, cloudUrl, ports}` while the lifecycle reader (`ClusterYamlSchema`) expects `{channel, workers, variant}`. Zod will strip the extra fields and apply defaults for missing ones, so `up` won't crash, but the written config loses `imageTag`/`cloudUrl`/`ports` on round-trip.
**Question**: Should this PR also fix the `cluster.yaml` schema mismatch, or is that a separate issue?
**Options**:
- A: Fix in this PR — add `imageTag`, `cloudUrl`, `ports` to `ClusterYamlSchema` (or move them elsewhere)
- B: Separate issue — `cluster.yaml` round-trip loss is non-blocking since Zod applies defaults
- C: Fix in this PR by removing extra fields from launch's cluster.yaml and relying on docker-compose.yml for those values

**Answer**: C — Fix in this PR by removing extra fields from launch's `cluster.yaml`; rely on `docker-compose.yml` for image/port concerns. `imageTag` → `docker-compose.yml` service `image:` field. `cloudUrl` → `cluster.json` (runtime identity). `ports` → `docker-compose.yml` ports stanza. `cluster.yaml` stays as project-level config (`channel, workers, variant`).

### Q4: Registry `variant`/`channel` enum validation
**Context**: The lifecycle `RegistryEntrySchema` uses strict enums (`variant: z.enum(['standard', 'microservices'])`, `channel: z.enum(['stable', 'preview'])`). Launch passes `config.variant` from the cloud API as a free string and hardcodes `channel: 'stable'`. If the cloud returns a variant not in the enum (e.g. `'custom'`), registry writes will fail Zod validation.
**Question**: Should the enum be the source of truth (reject unknown values), or should the schema be relaxed to accept any string with the enum as a default?
**Options**:
- A: Keep strict enums — cloud must return valid values; fail-fast on mismatch (Recommended)
- B: Use `z.string().default('standard')` — accept anything, lose validation
- C: Use `z.enum([...]).or(z.string())` — accept known values with type safety, allow unknown as fallback

**Answer**: A — Keep strict enums; cloud must return valid values; fail-fast on mismatch. **Important naming update**: rename variant enum values from `'standard' | 'microservices'` to `'cluster-base' | 'cluster-microservices'` to match architecture doc and GHCR image repo names. Update both lifecycle's existing schema and launch. Cloud-side launch-config (#474) should also use this enum.

### Q5: Registry `clusterId` nullability
**Context**: The lifecycle `RegistryEntrySchema` has `clusterId: z.string().nullable()` (supporting pre-activation clusters with no ID). Launch always has a `clusterId` from the cloud config and uses `clusterId: string` (non-nullable). FR-004 says to define the registry schema once and import it everywhere.
**Question**: When unifying the registry schema, should `clusterId` remain nullable (lifecycle's current behavior) or become required (launch's assumption)?
**Options**:
- A: Keep nullable — supports both pre-activation (`init`) and post-activation (`launch`) paths (Recommended)
- B: Make required — pre-activation clusters use a generated placeholder ID

**Answer**: A — Keep `clusterId` nullable. Supports both pre-activation `init` path (no clusterId until activation) and post-activation `launch` path (clusterId from cloud's launch-config). Lifecycle commands treat `null` as "pre-activation, cluster identity not yet established" and skip cluster-scoped operations gracefully.

## Batch 2 — 2026-04-30

### Q6: Deploy command has identical bugs
**Context**: The `deploy` command scaffolder (`packages/generacy/src/cli/commands/deploy/scaffolder.ts`) has identical issues — camelCase `cluster.json`, excess fields in `cluster.yaml`. The spec only mentions `launch/scaffolder.ts`. Since both commands share the same bug pattern, fixing one without the other leaves `generacy deploy` broken.
**Question**: Should this PR also fix `deploy/scaffolder.ts`, or is that a separate issue?
**Options**:
- A: Fix in this PR — deploy has the same bugs and should use the same unified schemas
- B: Separate issue — deploy is a different command and out of scope for this fix

**Answer**: A — Fix `deploy/scaffolder.ts` in this PR. Same bug pattern, same root cause, same fixes. Apply every Batch 1 decision identically to `deploy/scaffolder.ts`: snake_case `cluster.json` schema, `activated_at` omitted at scaffold time, required `orgId` from cloud (note: deploy flow gets `orgId` from the activation response, not launch-config), `cluster.yaml` minimized to `{channel, workers, variant}`, shared registry schema with strict enums and nullable `clusterId`. Extract scaffolder logic into a shared helper (`packages/generacy/src/cli/commands/cluster/scaffolder.ts` or similar) that both `launch` and `deploy` consume — duplication is small enough that the shared-helper move is worth doing now.
