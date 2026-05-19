# Data Model: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

## Overview

This cleanup has no new data model changes. It removes deprecated env var reading paths and renames a CLI flag. The data structures (types, schemas, persisted files) remain unchanged.

## Environment Variable Surface (After Cleanup)

### Orchestrator Context (in-cluster, set via `.generacy/.env`)

| Variable | Required | Type | Purpose |
|----------|----------|------|---------|
| `GENERACY_API_URL` | Yes | HTTP URL | Cloud API endpoint for activation device-flow |
| `GENERACY_RELAY_URL` | No | WSS URL | Cloud relay WebSocket endpoint (falls back to channel-derived URL) |
| `GENERACY_CHANNEL` | No | `'stable' \| 'preview'` | Used to derive relay URL when `GENERACY_RELAY_URL` unset |

### CLI Context (interactive, user's shell)

| Variable | Required | Type | Purpose |
|----------|----------|------|---------|
| `GENERACY_API_URL` | No | HTTP URL | Cloud API endpoint (default: `https://api.generacy.ai`) |

### Removed (no longer read)

| Variable | Previously Used By | Replacement |
|----------|-------------------|-------------|
| `GENERACY_CLOUD_URL` | CLI, orchestrator (activation + relay) | `GENERACY_API_URL`, `GENERACY_RELAY_URL` |

## CLI Flag Surface (After Cleanup)

| Flag | Canonical | Hidden Alias | Used By |
|------|-----------|-------------|---------|
| `--api-url <url>` | Yes | — | `launch`, `deploy` |
| `--cloud-url <url>` | No | Yes (deprecated, one release cycle) | `launch`, `deploy` |

## Unchanged Data Structures

These use `cloudUrl` as an internal field name but are **not** env var names. They remain unchanged per spec (out of scope):

- `LaunchConfig.cloudUrl` — Cloud API response field (deprecated, cloud-side cleanup)
- `RegistryEntry.cloudUrl` — Persisted in `~/.generacy/clusters.json` (stores app URL)
- `RelayConfigSchema.cloudUrl` — Internal orchestrator config (WSS relay URL)
- `ActivationConfigSchema.cloudUrl` — Internal orchestrator config (HTTP API URL)
- `cluster.json` `cloud_url` field — Persisted runtime identity file
