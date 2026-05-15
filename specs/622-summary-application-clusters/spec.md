# Feature Specification: ## Summary

Application clusters need a way to materialize a stored credential as a **file** at a configurable container path (e

**Branch**: `622-summary-application-clusters` | **Date**: 2026-05-15 | **Status**: Draft

## Summary

## Summary

Application clusters need a way to materialize a stored credential as a **file** at a configurable container path (e.g. GCP service account JSON at `/home/node/.config/gcloud/secrets/sa.json`) so user services in the cluster's compose can mount it. Today the credhelper supports `env`, `git-credential-helper`, `gcloud-external-account`, `localhost-proxy`, and `docker-socket-proxy` — none of these write an opaque blob to a stable role-defined path.

This issue also extends `.generacy/cluster.yaml` with an `appConfig:` section that declares the env vars and files an app needs, and adds control-plane endpoints that surface the manifest to the cloud UI (companion issue in generacy-cloud — link added once filed).

## Motivating example

A LiveKit voice agent app currently needs the user to clone the repo and hand-edit `.env` / `.env.local` with:

```
SERVICE_ANTHROPIC_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
LIVEKIT_SIP_TRUNK_ID, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
```

plus a compose mount `./secrets:/home/node/.config/gcloud/secrets:ro` for a GCP service account JSON. We want the user to launch via `npx generacy launch --claim=<code>` and configure all of this through the generacy.ai UI, without cloning the repo to the host.

## Scope

### 1. New `file` exposure kind
- Add `file` to `packages/credhelper/src/schemas/exposure.ts:3-9`:
  ```ts
  z.object({ kind: z.literal('file'), path: z.string(), mode: z.number().optional() })
  ```
- Add to role expose schema `packages/credhelper/src/schemas/roles.ts:3-8` (`as: 'file'`, `path`, `mode?`).
- Renderer (`packages/credhelper-daemon/src/exposure-renderer.ts`) writes the blob to the role-declared absolute path, owned by `credhelper:node`, default mode `0640`. The path must be inside an explicit allowlist root (e.g. `/var/lib/generacy-app-config/files/` plus per-variant configurable roots) to prevent role-author footguns.
- Files are wiped on session end. Documented trade-off: `file` exposure puts plaintext on tmpfs readable by the workflow uid — same trade-off as `env` exposure (see `docs/credentials-architecture-plan.md` §Secret lifecycle in tetrad-development).

### 2. New core plugin `credential-file`
- `packages/credhelper-daemon/src/plugins/core/credential-file.ts`. `resolve()` reads an opaque base64 blob from the backend; `renderExposure('file', secret, cfg)` returns the decoded bytes. `supportedExposures: ['file']` only.
- Extend the `gcp-service-account` plugin so its `key` mode supports `as: file` (writes the SA JSON to the configured path), keeping the existing `gcloud-external-account` exposure for impersonation mode.

### 3. Extend `.generacy/cluster.yaml` with `appConfig:`
Extend `packages/generacy/src/cli/commands/cluster/context.ts:9-13`:

```ts
export const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  appConfig: z.object({
    schemaVersion: z.literal('1'),
    env: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      secret: z.boolean().default(false),
      default: z.string().optional(),
      required: z.boolean().default(true),
    })).default([]),
    files: z.array(z.object({
      id: z.string(),
      description: z.string().optional(),
      mountPath: z.string(),
      required: z.boolean().default(true),
    })).default([]),
  }).optional(),
});
```

Example:

```yaml
channel: stable
workers: 1
variant: cluster-microservices
appConfig:
  schemaVersion: "1"
  env:
    - { name: SERVICE_ANTHROPIC_API_KEY, secret: true, description: "..." }
    - { name: LIVEKIT_URL, secret: false }
    - { name: TWILIO_AUTH_TOKEN, secret: true }
  files:
    - { id: gcp-sa-json, mountPath: "/home/node/.config/gcloud/secrets/sa.json" }
```

The cluster's entrypoint sources the materialized env file (`/var/lib/generacy-app-config/env`) and exposes the files dir as a stable read-only mount point that user services can volume-mount in compose.

### 4. Control-plane endpoints
- `GET /control-plane/app-config/manifest` — re-reads `.generacy/cluster.yaml` from the **cluster's local working tree** on every call and returns the parsed `appConfig:` section. Returns `null` if absent. Reading from the working tree (not GitHub) means a user can save edits without pushing and the UI sees them on next refresh.
- `GET /control-plane/app-config/values` — returns name + lastUpdated for set values; never returns secret values.
- `PUT /control-plane/app-config/env` — accepts `{ name, value, secret }`. `secret: true` delegates to credhelper as an `env-passthrough` credential. `secret: false` writes to the plain env file. **Permissive** — accepts names not declared in the manifest (lets users prototype with ad-hoc env vars; UI labels them "(not in manifest)").
- `DELETE /control-plane/app-config/env/:name`.
- `POST /control-plane/app-config/files/:id` — accepts a base64 blob; stores it via credhelper as a `credential-file` type with `file` exposure pointing at the manifest's `mountPath`.

### 5. CLI surface
- `npx generacy app-config show` — prints the parsed manifest plus which values are filled.
- `npx generacy app-config set <name> <value>` — local fallback for power users.

### Trust model
Values themselves remain cluster-local per `credentials-architecture-plan.md` v1.5 retarget. Names/structure persist via the committed `cluster.yaml` manifest in the repo; **values do not** — destroying the cluster requires re-entering them via the UI.

### Out of scope
- Manifest schema versioning beyond v1.
- File-watcher / auto-refresh on `cluster.yaml` changes (clients pull on demand).
- Hot reload of env files into already-running user services (sessions remain the refresh unit).

## Test plan
- [ ] Unit: `file` exposure renderer writes blob at the allowlisted path with correct mode/ownership; rejects paths outside the allowlist.
- [ ] Unit: `credential-file` plugin round-trips a base64 blob through cluster-local backend.
- [ ] Unit: `ClusterYamlSchema` accepts the example above; existing minimal `cluster.yaml` (no `appConfig:`) still parses unchanged.
- [ ] Integration: `GET /control-plane/app-config/manifest` returns the parsed `appConfig:` section read from the cluster's working tree; reflects an edit-without-push immediately.
- [ ] Integration: `PUT /control-plane/app-config/env` with `secret: true` becomes resolvable as an `env-passthrough` credential.
- [ ] Integration: `POST /control-plane/app-config/files/:id` results in the blob rendered at `mountPath` on next workflow session start.

## Related
- generacy-ai/generacy-cloud#583 — bootstrap wizard step + Settings panel that consume this manifest and these endpoints.
- `docs/credentials-architecture-plan.md` (tetrad-development) — adds a new exposure kind to the existing inventory.
- `docs/dev-cluster-architecture.md` §Cluster-relay extension (tetrad-development).


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
