# Data Model: #517 Activation cloud_url Fix

## Type Changes

### PollResponseSchema (activation-client)

**File**: `packages/activation-client/src/types.ts`

```diff
 export const PollResponseSchema = z.discriminatedUnion('status', [
   z.object({ status: z.literal('authorization_pending') }),
   z.object({ status: z.literal('slow_down') }),
   z.object({ status: z.literal('expired') }),
   z.object({
     status: z.literal('approved'),
     cluster_api_key: z.string().min(1),
     cluster_api_key_id: z.string().min(1),
     cluster_id: z.string().min(1),
     project_id: z.string().min(1),
     org_id: z.string().min(1),
+    cloud_url: z.string().url(),
   }),
 ]);
```

**Inferred type after change**:
```typescript
type PollResponse =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'approved'; cluster_api_key: string; cluster_api_key_id: string;
      cluster_id: string; project_id: string; org_id: string; cloud_url: string };
```

### ActivationResult (activation-client)

**File**: `packages/activation-client/src/types.ts`

```diff
 export interface ActivationResult {
   apiKey: string;
   clusterApiKeyId?: string;
   clusterId: string;
   projectId: string;
   orgId: string;
+  cloudUrl?: string;
 }
```

`cloudUrl` is optional because the existing-key path may read from a pre-fix `cluster.json` that lacks `cloud_url`.

### ClusterJsonSchema (orchestrator)

**File**: `packages/orchestrator/src/activation/types.ts`

No change required — `ClusterJsonSchema` already includes `cloud_url` as an optional field. The orchestrator was writing it (using the wrong value), and `readClusterJson` already parses it.

## File Format: cluster.json

**Path**: `/var/lib/generacy/cluster.json`

```json
{
  "cluster_id": "cls_abc123",
  "project_id": "prj_def456",
  "org_id": "org_ghi789",
  "cloud_url": "https://custom.generacy.example.com",
  "activated_at": "2026-04-30T12:00:00.000Z"
}
```

| Field | Type | Required | Source |
|-------|------|----------|--------|
| `cluster_id` | string | Yes | Cloud poll response |
| `project_id` | string | Yes | Cloud poll response |
| `org_id` | string | Yes | Cloud poll response |
| `cloud_url` | string (URL) | No | Cloud poll response (new: from `pollResult.cloud_url`) |
| `activated_at` | string (ISO) | Yes | Generated at activation time |

## Data Flow

```
Cloud API (POST /api/clusters/device-code/poll)
  │
  ▼  approved response with cloud_url
PollResponseSchema.parse()          ← FR-001: now accepts cloud_url
  │
  ▼  pollResult.cloud_url
writeClusterJson()                  ← FR-002: persists cloud-returned URL
  │
  ▼  ActivationResult { cloudUrl }
activate() return                   ← FR-003: propagates to caller
  │
  ▼  activationResult.cloudUrl
server.ts boot sequence             ← FR-004: overrides config
  │
  ├─► config.activation.cloudUrl = "https://custom.example.com"
  └─► config.relay.cloudUrl      = "wss://custom.example.com/relay"
```

## URL Derivation Logic

```
Input (HTTPS):  https://custom.generacy.example.com
Output (WSS):   wss://custom.generacy.example.com/relay

Input (HTTP):   http://localhost:3000
Output (WS):    ws://localhost:3000/relay
```

Rules:
1. Replace `https:` → `wss:` or `http:` → `ws:`
2. Strip trailing slash
3. Append `/relay`
