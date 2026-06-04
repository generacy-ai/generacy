# Data Model: `vscodeTunnelName` write path

**Feature**: 746-summary-cloud-deployed-cluster
**Status**: Complete
**Date**: 2026-06-03

This is not a new-data-model feature. The entities below already exist and are documented here only to make the write-path trace (FR-001) precise.

---

## Entities

### 1. `GENERACY_CLUSTER_ID` — env var (process input)

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| value | string (UUID) | Container env, set by deploy template | Read by `loadOptionsFromEnv` in `vscode-tunnel-manager.ts:81`. |

**Validation**: must be present, otherwise `loadOptionsFromEnv` throws. No format check — `deriveTunnelName` enforces the resulting name matches `/^[a-z][a-z0-9-]{0,19}$/`.

**Set by**:
- Local CLI: `scaffoldDockerCompose()` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` writes it into the generated `docker-compose.yml`.
- Cloud deploy (out of repo): `generacy-cloud services/api/.../cloud-deploy/{digitalocean.ts, compose-template.ts}` sets `GENERACY_CLUSTER_ID=${input.clusterId}` where `clusterId` is the UUID returned by `preApproveActivationCode`.

**Hypothesis #1** turns on whether the live Droplet's `.env` actually contains the UUID. Verified by `cat /opt/generacy/.env` on the Droplet.

---

### 2. `VsCodeTunnelManagerOptions.tunnelName` — derived runtime value

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| binPath | string | `VSCODE_CLI_BIN` env or `/usr/local/bin/code` | |
| tunnelName | string | `deriveTunnelName(GENERACY_CLUSTER_ID)` | `g-` + first 18 chars of de-hyphenated UUID. |

**Validation** (in `deriveTunnelName`): result must match `/^[a-z][a-z0-9-]{0,19}$/`; throws otherwise.

**For UUID `325cdcb9-5b8e-45fc-a1bc-1ec8570d561d`** → expected `g-325cdcb95b8e45fca1`.
**For projectId `Xr7fxq61PF57U2lOtoKe`** lower-cased and sliced → `g-xr7fxq61pf57u2loto` (the observed, regressing value — but note projectId is not a UUID and `deriveTunnelName` should not have been called on it).

---

### 3. `cluster.vscode-tunnel` relay event — outbound message

| Field | Type | Notes |
|-------|------|-------|
| status | enum | `starting` \| `authorization_pending` \| `connected` \| `disconnected` \| `error` |
| deviceCode | string? | only on `authorization_pending` |
| verificationUri | string? | only on `authorization_pending` |
| tunnelName | string? | **The ACTUAL registered name** — may differ from requested if Microsoft fell back (see `vscode-tunnel-manager.ts:104–111` and #743). |
| tunnelUrl | string? | parsed from `https://vscode.dev/tunnel/<name>/…` |
| error | string? | only on `error` |
| details | string? | optional context |

**Emitted by**: `emitTunnelEvent` in `vscode-tunnel-manager.ts:91–94`, which calls `getRelayPushEvent()("cluster.vscode-tunnel", payload)`.

**Wire format** (via `cluster-relay` `EventMessage`): `{ type: "event", event: "cluster.vscode-tunnel", data: { …above… }, timestamp }`.

**Consumer**: a handler in `generacy-cloud` (under investigation in FR-001 Layer B) persists the value into the Firestore cluster doc.

---

### 4. `ClusterMetadataPayload` — heartbeat metadata

Carried in the relay handshake and periodic metadata refresh. Source: `packages/orchestrator/src/services/relay-bridge.ts` `collectMetadata()` + `packages/cluster-relay/src/metadata.ts`.

| Field | Type | Notes |
|-------|------|-------|
| codeServerReady | boolean | Result of `probeCodeServerSocket()`. |
| controlPlaneReady | boolean? | Result of `probeControlPlaneSocket()`. |
| initResult | object? | Aggregated store-init status. |
| tunnelName | string? | **If present** — read-only confirmation of what the cluster registered. (Inspect whether this field exists today; if not, the only carrier is the event message.) |

**Note**: spec doesn't pin which carrier writes the cloud doc. FR-001 Layer B disambiguates: is the cloud handler reading from the relay event, the heartbeat metadata, both, or neither (i.e. cloud computes it from `projectId` instead)?

---

### 5. Firestore document: `organizations/{orgId}/clusters/{clusterId}`

Read-only from this repo; written by generacy-cloud. The relevant field:

| Field | Type | Expected | Observed (regression) |
|-------|------|----------|-----------------------|
| `vscodeTunnelName` | string | `deriveTunnelName(<cluster UUID>)` — e.g. `g-325cdcb95b8e45fca1` | `g-xr7fxq61pf57u2loto` (projectId-derived, pre-#744 behavior) |

**Write path** (under investigation):
- Hypothesized: cloud relay handler observes `cluster.vscode-tunnel` event, writes `data.tunnelName` to the doc.
- Alternate: cloud pre-computes from `projectId` at cluster-creation time (`preApproveActivationCode`).
- Alternate: cloud merges *both* — relay event updates, but initial seed remains projectId-derived (combined with #743 persistence semantics this should still self-heal — unless write semantics block updates).

---

## Relationships

```
GENERACY_CLUSTER_ID (env, UUID)
     │
     ▼
loadOptionsFromEnv  ──►  VsCodeTunnelManagerOptions.tunnelName = deriveTunnelName(UUID)
     │
     ▼
`code tunnel --name <tunnelName>` spawned
     │
     ▼ (parsed from stdout / actual registration)
actualTunnelName  ─►  emitTunnelEvent("cluster.vscode-tunnel", { tunnelName: actualTunnelName, … })
     │
     ▼ (over relay WebSocket)
generacy-cloud relay handler  ─►  Firestore doc `vscodeTunnelName`
```

The regression must originate in one of:

1. **Env** (UUID never reaches the process — hypothesis #1) — breaks at the first arrow.
2. **Code** (published tarball is pre-#744 despite version string — hypothesis #2) — `deriveTunnelName` is the old projectId-keyed version.
3. **Cache / write semantics** (actual registration is UUID-derived but the cloud doc still holds projectId — hypothesis #3 or a cloud-side write semantics bug) — breaks at the last arrow.
4. **Cloud computes it itself** (relay event is ignored or overridden — surfaced by FR-001 Layer B) — the last arrow doesn't read from the event at all.

---

## No new types or validation rules added by #746

If the diagnosis lands the fix in this repo, the most likely change is to a single function (`deriveTunnelName` or `loadOptionsFromEnv`) — no new types, no new schemas, no new persistence. The existing `Zod` message schemas in `packages/cluster-relay/src/messages.ts` remain unchanged.
