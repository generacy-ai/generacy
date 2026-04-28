# Implementation Plan: Cluster-Side Device-Flow Activation Client

**Feature**: On first cluster boot, run an OAuth-style device flow to obtain a long-lived cluster API key before any relay handshake attempt.
**Branch**: `492-context-first-cluster-boot`
**Status**: Complete

## Summary

Add a new `packages/orchestrator/src/activation/` module that runs before relay client construction in the orchestrator's startup path. On first boot (no key file at `/var/lib/generacy/cluster-api-key`), the module initiates an HTTP device-code flow against the Generacy cloud, prints a user-visible activation code, polls for approval, persists the API key, and returns it for relay config injection. Subsequent boots read the persisted key and skip activation.

## Technical Context

- **Language**: TypeScript (ESM, `"type": "module"`)
- **Runtime**: Node.js >= 20
- **HTTP**: `node:http` / `node:https` (native, matching credhelper-daemon pattern)
- **Validation**: Zod schemas
- **Logging**: Pino logger interface
- **Package**: `packages/orchestrator` (no new package needed)
- **Test framework**: Vitest (existing in orchestrator)

## Project Structure

```
packages/orchestrator/src/activation/
  index.ts              # Public API: activate() + types re-export
  client.ts             # HTTP client for device-code endpoints
  poller.ts             # Poll loop with slow_down / expired handling
  persistence.ts        # Atomic key-file read/write + cluster.json
  types.ts              # Zod schemas + TypeScript types
  errors.ts             # ActivationError subtypes

packages/orchestrator/src/activation/__tests__/
  client.test.ts        # Unit tests for HTTP client
  poller.test.ts        # Unit tests for poll loop
  persistence.test.ts   # Unit tests for file operations
  activate.test.ts      # Integration test with fake cloud server

packages/orchestrator/src/config/
  schema.ts             # Add clusterApiKeyId to RelayConfigSchema
  loader.ts             # Add GENERACY_CLOUD_URL env + key-file fallback wiring

packages/orchestrator/src/
  server.ts             # Insert activation call before relay construction
```

## Integration Points

### 1. Orchestrator Entry (`server.ts`)

Insert activation before relay client construction (~line 305):
```
const activationResult = await activate({ cloudUrl, logger, keyFilePath, ... });
config.relay.apiKey = activationResult.apiKey;
config.relay.clusterApiKeyId = activationResult.clusterApiKeyId;
```

### 2. Config Loader (`config/loader.ts`)

- Read `GENERACY_CLOUD_URL` env var (new)
- Derive fallback from relay WebSocket URL: `wss://` -> `https://`, strip `/relay`
- Expose `cloudUrl` on config object for activation module

### 3. Config Schema (`config/schema.ts`)

- Add `cloudUrl: z.string().url().optional()` to orchestrator RelayConfig
- Add `clusterApiKeyId: z.string().optional()`

### 4. Relay Handshake

- Per clarification Q4: populate `clusterApiKeyId` on `RelayConfig` from API key prefix
- Leave `activation.code` unset (vestigial)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Module returns key to caller | Option A from Q1 | Clean separation; orchestrator entry composes activation -> config -> relay |
| `GENERACY_CLOUD_URL` env var | New env var + derived fallback | Supports self-hosted and local testing; fallback avoids extra config for standard deploys |
| Retry budget for initial request | 5 retries, exponential (2s-32s, ~62s) | Balances first-boot network startup with clear failure messaging |
| Device code expiry | Auto-restart flow (max 3 cycles) | Avoids container crash; bounded to prevent infinite loops |
| HTTP client | `node:http`/`node:https` native | Matches credhelper-daemon pattern; no new dependencies |
| Key file path | `/var/lib/generacy/cluster-api-key` | Standard Linux data dir; mode 0600 for security |
| Companion metadata | `/var/lib/generacy/cluster.json` | Non-secret cluster identity (cluster_id, project_id, org_id, cloud_url) |
| Atomic write | Write to `.tmp` then `rename()` | Prevents partial reads on crash |

## Security Considerations

- API key never logged (scrub from all log output)
- Key file mode `0600`, owned by `node` uid
- Atomic writes prevent partial key exposure
- No plaintext key anywhere outside the protected file
- `cluster.json` contains only non-secret metadata

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Cloud unreachable on device-code request | Retry 5x with exponential backoff (2s-32s), then fail fast with clear error |
| Device code expires before approval | Log message, auto-request new code (up to 3 cycles), then exit non-zero |
| `slow_down` poll response | Increase poll interval by 5 seconds per RFC 8628 |
| Key file unwritable (permissions) | Fail fast with descriptive error |
| Invalid JSON from cloud | Zod parse failure, retry or fail depending on endpoint |
| Key file present but corrupt | Treat as absent, re-activate |

## Dependencies

- No new npm packages required
- Uses `node:http`, `node:https`, `node:fs/promises`, `node:path`, `node:crypto`
- Existing: `zod` (already in orchestrator)
- Existing: Pino logger interface (already in orchestrator)
