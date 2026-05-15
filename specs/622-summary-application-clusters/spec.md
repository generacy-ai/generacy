# Feature Specification: Credhelper `file` exposure + `credential-file` plugin + `appConfig:` in cluster.yaml

**Branch**: `622-summary-application-clusters` | **Date**: 2026-05-15 | **Status**: Draft

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

## User Stories

### US1: App developer configures credentials via UI

**As an** app developer deploying a voice agent on Generacy,
**I want** to declare my app's required env vars and credential files in `cluster.yaml` and fill their values through the Generacy cloud UI,
**So that** I can launch a fully configured cluster with `npx generacy launch --claim=<code>` without cloning the repo or manually editing `.env` files.

**Acceptance Criteria**:
- [ ] `appConfig:` section in `cluster.yaml` declares env vars (name, secret flag, description, default, required) and files (id, mountPath, description, required)
- [ ] Cloud UI reads the manifest via `GET /control-plane/app-config/manifest` and renders a form
- [ ] Setting a secret env var via `PUT /control-plane/app-config/env` stores it encrypted via credhelper
- [ ] Setting a non-secret env var writes it to the plain env file
- [ ] Uploading a file via `POST /control-plane/app-config/files/:id` stores and materializes it at `mountPath`

### US2: Credential file materialization for services

**As a** cluster operator running a GCP-dependent service,
**I want** a service account JSON file to appear at a stable container path (e.g. `/home/node/.config/gcloud/secrets/sa.json`),
**So that** my compose services can mount it read-only without manual file placement.

**Acceptance Criteria**:
- [ ] `file` exposure kind writes a blob to the role-declared absolute path with mode `0640`
- [ ] Path is validated against an allowlist root to prevent arbitrary writes
- [ ] File is cleaned up on session end

### US3: Power-user CLI fallback

**As a** power user working locally,
**I want** to set app config values from the CLI (`npx generacy app-config set <name> <value>`),
**So that** I can configure clusters without needing the cloud UI.

**Acceptance Criteria**:
- [ ] `app-config show` prints the manifest and which values are filled
- [ ] `app-config set` writes env vars or files via the same control-plane endpoints

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

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `file` exposure kind to credhelper schemas (exposure.ts, roles.ts) | P1 | New Zod discriminated union variant |
| FR-002 | Exposure renderer writes blob to allowlisted absolute path with mode 0640 | P1 | Path allowlist prevents arbitrary writes |
| FR-003 | File exposure cleaned up on session end | P1 | Same lifecycle as env exposure |
| FR-004 | New `credential-file` core plugin with base64 blob resolve + file render | P1 | `supportedExposures: ['file']` only |
| FR-005 | Extend `gcp-service-account` plugin to support `as: file` for key mode | P2 | Keeps existing `gcloud-external-account` exposure |
| FR-006 | Extend `ClusterYamlSchema` with optional `appConfig:` section | P1 | Backward-compatible (`.optional()`) |
| FR-007 | `GET /control-plane/app-config/manifest` returns parsed appConfig from working tree | P1 | Re-reads on every call; no caching |
| FR-008 | `GET /control-plane/app-config/values` returns names + lastUpdated, never secret values | P1 | |
| FR-009 | `PUT /control-plane/app-config/env` stores secret via credhelper, non-secret to plain file | P1 | Permissive: accepts undeclared names |
| FR-010 | `DELETE /control-plane/app-config/env/:name` removes value | P1 | |
| FR-011 | `POST /control-plane/app-config/files/:id` stores base64 blob via credhelper | P1 | Materializes at manifest's mountPath |
| FR-012 | CLI `app-config show` prints manifest + fill status | P2 | |
| FR-013 | CLI `app-config set <name> <value>` writes via control-plane endpoint | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | File exposure path validation | 100% rejection of paths outside allowlist | Unit test: attempt writes outside root, verify rejection |
| SC-002 | Backward compatibility | Existing `cluster.yaml` without `appConfig:` parses unchanged | Unit test with minimal cluster.yaml |
| SC-003 | Secret isolation | Secret values never returned by `GET /values` endpoint | Integration test: set secret, verify absence in GET response |
| SC-004 | End-to-end file materialization | Uploaded file appears at `mountPath` on next session start | Integration test: POST file, start session, verify path |

## Assumptions

- Credhelper daemon is running and accessible via its control socket in the cluster container.
- `ClusterLocalBackend` (AES-256-GCM encrypted file store) is initialized before app-config endpoints are called.
- The cluster's entrypoint will source `/var/lib/generacy-app-config/env` — companion change in cluster-base repo.
- Cloud UI companion (generacy-cloud#583) consumes these endpoints; cloud-side changes are out of scope here.

## Out of Scope

- Manifest schema versioning beyond v1.
- File-watcher / auto-refresh on `cluster.yaml` changes (clients pull on demand).
- Hot reload of env files into already-running user services (sessions remain the refresh unit).
- Cloud UI implementation (generacy-cloud#583).

## Test Plan

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

---

*Generated by speckit*
