# Research: Per-cluster tunnel name + identity for multi-cluster

## Decisions

### 1. Tunnel name source: UUID-derived (`g-<uuid18>`)

**Decision**: Restore `deriveTunnelName` input to `GENERACY_CLUSTER_ID`. Keep the 20-char/lowercase/letter-initial helper signature unchanged.

**Rationale** (Q1→A): The 18-hex slice of a UUID is unique to ~2^-72 collision probability per pair; no sanitization, no display-name coupling, no rename cascade. The helper is the smallest possible surface that satisfies Microsoft's tunnel constraint.

**Alternatives considered**:
- *Name-derived* (Q1→B): would require slug + collision-suffix logic, force tunnel-name regeneration on rename, and couple two lifecycles (display name + tunnel name) that the spec explicitly wants decoupled (FR-008).
- *Hybrid `<short-name>-<6hex>`* (Q1→C): half the bits of collision protection, still couples display + tunnel names.

**Why the #618 fix to use project id is being reverted**: #618 keyed tunnel name on the project id to survive activation key-rotation. The original problem was that cloud regenerated cluster ids per activation, so re-activating a project produced a fresh tunnel registration that diverged from the persisted `vscodeTunnelName`. Cloud-side `merge:true` persistence (generacy-cloud#563) and the per-cluster preservation in #792 mean cluster ids are now stable across activations *of the same cluster*, and each cluster gets its own preserved name. The multi-cluster requirement (FR-001) is incompatible with project-id derivation — two clusters under one project would collide on every relaunch.

### 2. Default-name uniqueness scope: per `(projectId, deploymentMode='local')`

**Decision** (Q2→B): The default-name generator filters `~/.generacy/clusters.json` by `projectId` AND `deploymentMode === 'local'` before counting.

**Rationale**: The literal `-local-` in the pattern only makes sense for local clusters. SSH/cloud clusters increment a separate sequence (or have no default at all, per Q5→B). Mixing modes would produce confusing names like `acme-local-1` for an SSH cluster.

**Implementation note**: Existing registry entries written before this PR lack `deploymentMode`. The schema makes the field optional and the generator treats missing values as `'local'` for backward compatibility. New entries always set the field explicitly.

### 3. Cluster UUID minting site: cloud (status quo)

**Decision** (Q3→A): Cloud mints the UUID during device-flow activation. CLI scaffolds with `cluster_id: ''` or omits the field, then writes back the cloud-returned id.

**Rationale**: Avoids propose/confirm conflict handling. The default-name generator (FR-004) does not depend on the cluster UUID — it uses the `projectId` returned in `LaunchConfig` (fetched *before* activation) and counts local registry entries.

**Sequence**:
1. CLI fetches `LaunchConfig` from cloud → has `projectId`, `projectName`, `clusterId`.
2. CLI resolves display name: `opts.name` (normalized) or `generateDefaultName(projectId, projectName)`.
3. CLI scaffolds `.generacy/` with all four fields (`cluster_id`, `project_id`, `org_id`, `cloud_url`) plus `display_name`.
4. CLI registers in `~/.generacy/clusters.json` with `displayName` + `deploymentMode`.
5. Activation runs container-side; cluster id is already known and persisted.

### 4. Name normalization algorithm: permissive + normalize

**Decision** (Q4→B): One shared algorithm for `--name` input and `<sanitized-project>` derivation. Specifically:

```
normalize(input, maxLen):
  s = input.toLowerCase()
  s = s.replace(/[^a-z0-9-]+/g, '-')        // any run of non-alphanum-hyphen → single '-'
  s = s.replace(/^-+|-+$/g, '')              // trim leading/trailing '-'
  s = s.slice(0, maxLen)
  if (s === '') return null                  // caller rejects
  if (!/^[a-z]/.test(s)) s = `c-${s}`        // prepend 'c-' if not letter-initial
  s = s.slice(0, maxLen)                     // re-truncate if prefix pushed over
  return s
```

`--name` uses `maxLen=63`. The `<sanitized-project>` component uses `maxLen=40`, leaving room for the `-local-<n>` suffix.

**Rationale**: One algorithm reduces test surface and keeps user-provided names visually consistent with auto-generated names. Permissive input is friendlier for non-Latin scripts (which collapse to a single `-` and trigger the `c-` prefix); rejecting only empty-normalization is the minimum gate.

**Alternatives considered**:
- *Strict slug* (Q4→A): rejects names like "ACME Frontend" which users will reasonably try. Higher friction with no real benefit since the tunnel name is UUID-derived anyway.
- *Permissive + preserve* (Q4→C): UTF-8 display name + separate slug for the registry. Two-string identity invites display/identity drift bugs.

### 5. `--name` parity for `generacy deploy`: flag only, no default

**Decision** (Q5→B): `generacy deploy --name <name>` is accepted and normalized identically to `launch`. Without `--name`, `deploy` falls back to the existing behavior (cluster id as display name). A `<project>-ssh-<n>` / `<project>-<host>-<n>` default generator is deferred to a follow-up.

**Rationale**: Cheap to add the flag (one `commander` line + threading); avoids surprising users with `launch`/`deploy` inconsistency. The default generator for SSH deploys needs separate clarification (port? host? hostname slug?) so it gets its own issue.

## Implementation Patterns to Follow

### Lifecycle action invocation from CLI

Existing pattern: `packages/generacy/src/cli/commands/claude-login` proxies a command into the orchestrator container via `docker compose exec`. For lifecycle actions, the existing path is to POST against the orchestrator's relay-routed `/control-plane/lifecycle/:action` endpoint. We can either:

- (A) Use `docker compose exec orchestrator curl --unix-socket /run/generacy-control-plane/control.sock http://x/lifecycle/vscode-tunnel-stop -XPOST` from the CLI.
- (B) Add a small `lifecycleAction(ctx, action, body?)` helper alongside `runCompose(ctx, args)` in `commands/cluster/compose.ts`.

We choose **B** — wraps the `docker compose exec` invocation, returns `{ok, status, body}`, used uniformly by `stop`/`down`/`destroy`. Best-effort: 10s timeout, swallow non-2xx, log a warning.

### Scaffolder threading

Existing pattern: both `launch/scaffolder.ts` and `deploy/scaffolder.ts` are thin wrappers around `cluster/scaffolder.ts`. Adding `displayName` follows that — thread `displayName` into `ScaffoldClusterJsonInput` and `ScaffoldEnvInput`, and let the shared writer handle the file format. Avoids duplicating env-var construction.

### Registry sequence generation

Existing pattern: `readRegistry()` → mutate → `writeRegistry()` (atomic tmp+rename). The default-name generator is pure given the registry array. We don't need a lock file — two concurrent launches are rare enough that the worst case (both pick `-local-3`) is preferable to introducing OS-level locking.

```typescript
function generateDefaultName(
  projectId: string,
  projectName: string,
  registry: Registry,
): string {
  const project = sanitizeProjectComponent(projectName);  // maxLen=40
  const taken = new Set(
    registry
      .filter((e) => e.projectId === projectId && (e.deploymentMode ?? 'local') === 'local')
      .map((e) => e.displayName)
  );
  for (let n = 1; ; n++) {
    const candidate = `${project}-local-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
```

Note: this assumes the registry entry also gains a `projectId` field. Current schema doesn't have it — it stores `clusterId` only. We add `projectId: z.string().optional()` so old entries that lack it simply don't participate in the sequence.

## Key References

- `packages/control-plane/src/services/vscode-tunnel-manager.ts` — current `deriveTunnelName` + `loadOptionsFromEnv` (lines 51–76, 102–137).
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — `scaffoldClusterJson` (snake_case writer), `scaffoldEnvFile` (`GENERACY_*` vars).
- `packages/generacy/src/cli/commands/cluster/registry.ts` — `RegistryEntrySchema`, `readRegistry`, `writeRegistry`, `upsertRegistryEntry`.
- `packages/orchestrator/src/types/relay.ts` — `ClusterMetadataPayload`.
- `packages/cluster-relay/src/messages.ts` — `ClusterMetadata`, `ClusterMetadataSchema`.
- `packages/control-plane/src/schemas.ts` — `LifecycleActionSchema`.
- generacy-cloud#792 (companion: data model + UI), #563 (cloud merge:true persistence), #618 (the fix being reverted), #743 (actual-tunnel-name).
