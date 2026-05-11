# Data Model: Register /control-plane Unix-Socket Route on Relay Client

## Core Types (existing, no changes)

### RouteEntry (`packages/cluster-relay/src/config.ts:3-6`)

```typescript
interface RouteEntry {
  prefix: string;  // Must start with '/'
  target: string;  // HTTP URL or 'unix://<path>'
}
```

### RelayConfig (`packages/cluster-relay/src/config.ts:8-20`)

```typescript
interface RelayConfig {
  apiKey: string;
  relayUrl: string;
  orchestratorUrl: string;
  orchestratorApiKey?: string;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  baseReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  routes: RouteEntry[];           // Used by dispatcher
  activationCode?: string;
  clusterApiKeyId?: string;
}
```

### ClusterRelayClientOptions (`packages/cluster-relay/src/relay.ts:22-33`)

Current (pre-#576):
```typescript
interface ClusterRelayClientOptions {
  apiKey: string;
  cloudUrl?: string;
  baseReconnectDelayMs?: number;
  orchestratorUrl?: string;
  orchestratorApiKey?: string;
  // ← no routes field
}
```

After #576:
```typescript
interface ClusterRelayClientOptions {
  apiKey: string;
  cloudUrl?: string;
  baseReconnectDelayMs?: number;
  orchestratorUrl?: string;
  orchestratorApiKey?: string;
  routes?: RouteEntry[];          // NEW from #576
}
```

## Data Flow

### Route Configuration (compile-time)

```
initializeRelayBridge()
  └── new RelayClientImpl({
        ...config,
        routes: [{ prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' }]
      })
        └── constructor parses into RelayConfig
              └── sortRoutes(routes) → stored as this.config.routes
```

### Request Dispatch (runtime)

```
api_request { path: '/control-plane/credentials/foo', method: 'PUT', body: {...} }
  └── resolveRoute('/control-plane/credentials/foo', routes)
        └── match: { route: { prefix: '/control-plane', target: 'unix://...' }, strippedPath: '/credentials/foo' }
              └── forwardToUnixSocket('/run/generacy-control-plane/control.sock', 'PUT', '/credentials/foo', ...)
                    └── control-plane router: PUT /credentials/foo → handlePutCredential
```

## Validation Rules

- `RouteEntry.prefix` must start with `/` (Zod: `z.string().startsWith('/')`)
- `RouteEntry.target` is a free-form string (`z.string()`) — `unix://` detection is runtime logic in `dispatcher.ts`
- `routes` array defaults to `[]` in `RelayConfigSchema` — omission is safe

## Relationships

```
ClusterRelayClientOptions --[parsed by]--> RelayConfig --[used by]--> handleApiRequest()
                                                              │
                                                    resolveRoute(path, config.routes)
                                                              │
                                                    RouteEntry.target --[if unix://]--> forwardToUnixSocket()
                                                                       [else]--------> forwardToHttp()
```
