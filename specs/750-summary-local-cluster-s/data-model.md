# Data Model: Identity-Split Detection

## Overview

No new persisted entities. The detector reads two existing values, compares them, and (on mismatch) sends one relay event. The relay event payload is the only new shape introduced.

## Inputs (existing data sources)

### Environment Variable
| Name | Type | Source | Required for detection? |
|------|------|--------|-------------------------|
| `GENERACY_CLUSTER_ID` | string (UUID) | `.generacy/.env` mounted into the orchestrator container at compose time | Yes — absent → skip detection silently |

### Persisted File: `/var/lib/generacy/cluster.json`
Schema already defined in `packages/orchestrator/src/activation/types.ts:17`:
```ts
const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});
type ClusterJson = z.infer<typeof ClusterJsonSchema>;
```
- Written by `activate()` post-device-code-approval (`activation/index.ts:81,160`).
- Read by the detector via existing `readClusterJson(path)` helper.
- Missing or schema-invalid → `null` → skip detection silently.

## Detector internals

### `DetectionOutcome` (return type, internal — for testability)
```ts
export type DetectionOutcome =
  | { kind: 'no-env'; envClusterId: undefined }
  | { kind: 'no-cluster-json'; envClusterId: string }
  | { kind: 'match'; clusterId: string }
  | { kind: 'mismatch'; envClusterId: string; clusterJsonClusterId: string; emitted: boolean };
```

- `no-env`: `process.env.GENERACY_CLUSTER_ID` is unset or empty.
- `no-cluster-json`: env is set but `readClusterJson` returned `null`.
- `match`: both present and equal — happy path.
- `mismatch`: both present and unequal. `emitted: true` means we sent the relay event this call; `emitted: false` means we suppressed because the module-level once-flag was already set.

Used internally and by tests; not exposed on the relay wire.

### Module-level state (in `identity-split-detector.ts`)
```ts
let hasEmitted = false;
```
- Set to `true` the first time the detector emits the relay event.
- Reset only via `resetIdentitySplitDetectionState()` (test helper).
- Container restart = module re-import = `hasEmitted` resets to `false`. By design.

### Public function signature
```ts
export interface DetectIdentitySplitOptions {
  clusterJsonPath: string;
  env?: NodeJS.ProcessEnv;  // defaults to process.env, injectable for tests
  sendRelayEvent?: (channel: 'cluster.identity-split', payload: IdentitySplitEvent) => void;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export async function detectIdentitySplit(
  options: DetectIdentitySplitOptions
): Promise<DetectionOutcome>;
```

## Output (new): Relay Event Payload

### Event channel
`cluster.identity-split`

### Payload shape
```ts
export interface IdentitySplitEvent {
  /** Cluster ID from process.env.GENERACY_CLUSTER_ID at detection time. */
  env_cluster_id: string;
  /** Cluster ID from /var/lib/generacy/cluster.json at detection time. */
  cluster_json_cluster_id: string;
  /** ISO-8601 timestamp of detection. */
  detected_at: string;
}
```

### Validation rules
- Both id fields MUST be non-empty strings (validated at detection time before emission — both come from already-validated sources, but defense-in-depth).
- `detected_at` MUST be a valid ISO-8601 timestamp (set via `new Date().toISOString()`).
- The two id fields MUST be different (precondition of emission — match path never emits).

### Naming conventions
- Channel uses dot-separated `cluster.<noun>` (matches `cluster.bootstrap`, `cluster.credentials`, etc.).
- Payload uses snake_case (matches `cluster.json` field names, the original source of one of the ids).

## Relationships

```
.generacy/.env (host)
       │
       │ mounted as compose env-file
       ▼
process.env.GENERACY_CLUSTER_ID (orchestrator container)
       │
       │     ┌─────────────────────┐
       └────►│ detectIdentitySplit │◄──── readClusterJson('/var/lib/generacy/cluster.json')
             └──────────┬──────────┘
                        │
                        │ on mismatch + first call only
                        ▼
       sendRelayEvent('cluster.identity-split', payload)
                        │
                        ▼
       ClusterRelayClient.send(EventMessage) ──► cloud
                                                    │
                                                    ▼
                                  (cloud companion) UI banner
```

## State transitions

```
hasEmitted = false      ───────────►   hasEmitted = true
       │                                       │
       │ subsequent calls                      │ subsequent calls
       │ (match or no-data)                    │ (any outcome)
       │                                       │
       ▼                                       ▼
   no emission                          no emission
   (per outcome)                        (suppressed)
```

There is no transition from `true` → `false` in production. Tests use `resetIdentitySplitDetectionState()` to reset.
