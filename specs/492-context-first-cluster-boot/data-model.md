# Data Model: Cluster-Side Device-Flow Activation

## Core Types

### DeviceCodeRequest

Sent to `POST {cloudUrl}/api/clusters/device-code`.

```typescript
// No request body — the cloud generates the code
```

### DeviceCodeResponse

Returned from `POST {cloudUrl}/api/clusters/device-code`.

```typescript
const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),         // e.g. "ABCD-1234"
  verification_uri: z.string().url(),    // e.g. "https://generacy.ai/cluster-activate"
  interval: z.number().int().positive(), // poll interval in seconds
  expires_in: z.number().int().positive(), // seconds until device_code expires
});

type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;
```

### PollRequest

Sent to `POST {cloudUrl}/api/clusters/device-code/poll`.

```typescript
const PollRequestSchema = z.object({
  device_code: z.string().min(1),
});

type PollRequest = z.infer<typeof PollRequestSchema>;
```

### PollResponse

Returned from `POST {cloudUrl}/api/clusters/device-code/poll`.

```typescript
const PollStatusSchema = z.enum([
  'authorization_pending',
  'slow_down',
  'expired',
  'approved',
]);

const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authorization_pending'),
  }),
  z.object({
    status: z.literal('slow_down'),
  }),
  z.object({
    status: z.literal('expired'),
  }),
  z.object({
    status: z.literal('approved'),
    cluster_api_key: z.string().min(1),
    cluster_api_key_id: z.string().min(1),
    cluster_id: z.string().min(1),
    project_id: z.string().min(1),
    org_id: z.string().min(1),
  }),
]);

type PollResponse = z.infer<typeof PollResponseSchema>;
```

### ActivationResult

Returned from the `activate()` function to the orchestrator entry.

```typescript
const ActivationResultSchema = z.object({
  apiKey: z.string().min(1),
  clusterApiKeyId: z.string().optional(),
  clusterId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
});

type ActivationResult = z.infer<typeof ActivationResultSchema>;
```

### ActivationOptions

Configuration for the `activate()` function (DI-friendly).

```typescript
interface ActivationOptions {
  cloudUrl: string;
  keyFilePath: string;        // default: /var/lib/generacy/cluster-api-key
  clusterJsonPath: string;    // default: /var/lib/generacy/cluster.json
  logger: Logger;             // Pino Logger interface
  maxCycles?: number;         // max device-code cycles on expiry (default: 3)
  maxRetries?: number;        // max retries for initial HTTP request (default: 5)
  httpClient?: HttpClient;    // injectable for testing
}
```

## Persisted Files

### `/var/lib/generacy/cluster-api-key`

- **Mode**: `0600`
- **Content**: Raw API key string (no JSON wrapper)
- **Owner**: `node` uid (same as orchestrator process)

### `/var/lib/generacy/cluster.json`

- **Mode**: `0644`
- **Content**: Non-secret cluster metadata

```typescript
const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

type ClusterJson = z.infer<typeof ClusterJsonSchema>;
```

## Injectable HTTP Client Interface

```typescript
interface HttpClient {
  post<T>(url: string, body?: unknown): Promise<HttpResponse<T>>;
}

interface HttpResponse<T> {
  status: number;
  data: T;
}
```

## Error Types

```typescript
class ActivationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ActivationError';
  }
}

// Codes:
// 'CLOUD_UNREACHABLE' — all retries exhausted reaching cloud
// 'DEVICE_CODE_EXPIRED' — all device-code cycles exhausted
// 'KEY_WRITE_FAILED' — cannot persist key file
// 'INVALID_RESPONSE' — Zod parse failure on cloud response
```

## Relationships

```
ActivationOptions
  └──> activate()
        ├──> client.requestDeviceCode() -> DeviceCodeResponse
        ├──> poller.pollForApproval() -> PollResponse (approved)
        ├──> persistence.writeKeyFile(apiKey)
        ├──> persistence.writeClusterJson(metadata)
        └──> ActivationResult
              └──> server.ts sets config.relay.apiKey + config.relay.clusterApiKeyId
                    └──> ClusterRelay handshake includes clusterApiKeyId
```
