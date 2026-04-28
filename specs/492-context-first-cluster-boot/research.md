# Research: Cluster-Side Device-Flow Activation

## Technology Decisions

### 1. HTTP Client: Native `node:http`/`node:https`

**Chosen**: Native Node.js HTTP modules
**Alternatives considered**:
- `undici` (Node built-in fetch) — viable but the credhelper-daemon already establishes the `node:http` pattern for internal HTTP clients in this monorepo. Consistency wins.
- `axios`/`got` — unnecessary dependency for simple POST requests with JSON bodies.

**Pattern reference**: `packages/credhelper-daemon/src/clients/` uses `node:http` with `http.request()` for Unix socket communication. The activation client follows the same style but targets TCP/TLS.

### 2. Device Flow Protocol: RFC 8628

The activation flow follows [RFC 8628 - OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628):

- **Device Authorization Request**: `POST /api/clusters/device-code` -> returns `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`
- **Device Access Token Request**: `POST /api/clusters/device-code/poll` with `device_code` -> returns status (`authorization_pending`, `slow_down`, `expired`, `approved`)
- **`slow_down`**: Increase polling interval by 5 seconds (RFC 8628 Section 3.5)
- **`expires_in`**: Absolute bound on polling duration

### 3. Atomic File Writes

**Pattern**: Write to `<path>.tmp` then `fs.rename()` (atomic on same filesystem).

```typescript
await fs.writeFile(tmpPath, content, { mode: 0o600 });
await fs.rename(tmpPath, targetPath);
```

This ensures readers never see partial content. The `/var/lib/generacy/` directory is expected to be on a single filesystem.

### 4. Retry Strategy

**Initial request retries** (cloud unreachable):
- 5 attempts with exponential backoff: 2s, 4s, 8s, 16s, 32s (~62s total)
- Jitter: +/- 10% to avoid thundering herd

**Device code expiry**:
- Up to 3 full device-code cycles before hard exit
- Each cycle bounded by `expires_in` from the server response

**Poll interval**:
- Start at server-provided `interval` (typically 5s)
- Increase by 5s on each `slow_down` response
- Hard maximum: 60s (prevent unbounded growth)

### 5. Cloud URL Derivation

Precedence:
1. `GENERACY_CLOUD_URL` env var (explicit)
2. Derived from relay WebSocket URL: `wss://api.generacy.ai/relay` -> `https://api.generacy.ai`
3. Hard-coded default: `https://api.generacy.ai`

Derivation logic:
```typescript
function deriveCloudUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  return url.origin;
}
```

## Implementation Patterns

### Module Entry Pattern

Following the credhelper-daemon DI pattern, the `activate()` function accepts injected dependencies:

```typescript
export interface ActivationOptions {
  cloudUrl: string;
  keyFilePath: string;
  clusterJsonPath: string;
  logger: Logger;
  maxCycles?: number;        // default 3
  maxRetries?: number;       // default 5
  httpClient?: HttpClient;   // injectable for testing
}

export interface ActivationResult {
  apiKey: string;
  clusterApiKeyId?: string;
  clusterId: string;
  projectId: string;
  orgId: string;
}
```

### Testability

- HTTP client injectable -> mock in unit tests
- File system operations injectable -> mock or use temp directories
- Integration test spins up a local HTTP server mimicking the cloud device-code endpoints
- Test scenarios: happy path, slow_down, expired + auto-retry, cloud unreachable, corrupt key file

### Logging

All log output uses Pino structured logging:
- `info`: "Checking for existing cluster API key", "Activation code obtained", "Cluster activated successfully"
- `warn`: "Device code expired, requesting new code (cycle N/3)", "Cloud unreachable, retrying (N/5)"
- `error`: "Activation failed after all retries", "Cannot write key file"
- **Never log**: The API key value itself. Use `clusterApiKeyId` (prefix) for diagnostics.

## Key Sources

- [RFC 8628 - OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- Existing relay handshake: `packages/cluster-relay/src/relay.ts:364-369`
- Existing config loader: `packages/orchestrator/src/config/loader.ts`
- Credhelper HTTP client pattern: `packages/credhelper-daemon/src/clients/`
- Architecture doc: `docs/dev-cluster-architecture.md` (in tetrad-development repo)
