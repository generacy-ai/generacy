# Data Model: Cluster-relay protocol additions and path-prefix dispatcher

## New Types

### Actor

Identity of the cloud-side user initiating a relayed API request.

```typescript
interface Actor {
  userId: string;
  sessionId?: string;
}
```

**Zod schema**:
```typescript
const ActorSchema = z.object({
  userId: z.string(),
  sessionId: z.string().optional(),
});
```

### Activation

First-launch claim or reconnect-with-API-key data sent during handshake.

```typescript
interface Activation {
  code: string;
  clusterApiKeyId?: string;
}
```

**Zod schema**:
```typescript
const ActivationSchema = z.object({
  code: z.string(),
  clusterApiKeyId: z.string().optional(),
});
```

### RouteEntry

A single entry in the dispatcher route table.

```typescript
interface RouteEntry {
  prefix: string;  // Must start with '/'
  target: string;  // HTTP URL or 'unix:///path/to/sock'
}
```

**Zod schema**:
```typescript
const RouteEntrySchema = z.object({
  prefix: z.string().startsWith('/'),
  target: z.string(),
});
```

## Modified Types

### ApiRequestMessage (extended)

```diff
 interface ApiRequestMessage {
   type: 'api_request';
   correlationId: string;
   method: string;
   path: string;
   headers?: Record<string, string>;
   body?: unknown;
+  actor?: Actor;
 }
```

### HandshakeMessage (extended)

```diff
 interface HandshakeMessage {
   type: 'handshake';
   metadata: ClusterMetadata;
+  activation?: Activation;
 }
```

### RelayConfig (extended)

```diff
 interface RelayConfig {
   apiKey: string;
   relayUrl: string;
   orchestratorUrl: string;
   orchestratorApiKey?: string;
   requestTimeoutMs: number;
   heartbeatIntervalMs: number;
   baseReconnectDelayMs: number;
   maxReconnectDelayMs: number;
+  routes: RouteEntry[];          // default: []
+  activationCode?: string;
+  clusterApiKeyId?: string;
 }
```

## Dispatcher Internal Types

### RouteMatch

Result of a successful prefix match.

```typescript
interface RouteMatch {
  route: RouteEntry;
  strippedPath: string;  // Path with prefix removed, always starts with '/'
}
```

## Relationships

```
RelayConfig
 ├── routes: RouteEntry[]        ← Dispatcher route table
 ├── orchestratorUrl: string     ← Implicit fallback target
 ├── activationCode?: string   ──┐
 └── clusterApiKeyId?: string  ──┤
                                  ▼
HandshakeMessage.activation?: Activation

ApiRequestMessage.actor?: Actor
        │
        ▼
HTTP Headers (on forward):
  x-generacy-actor-user-id
  x-generacy-actor-session-id
```

## Validation Rules

| Field | Rule |
|-------|------|
| `Actor.userId` | Non-empty string |
| `Actor.sessionId` | Optional string |
| `Activation.code` | Non-empty string |
| `Activation.clusterApiKeyId` | Optional string |
| `RouteEntry.prefix` | Must start with `/` |
| `RouteEntry.target` | Non-empty string (HTTP URL or `unix://` path) |
| `RelayConfig.routes` | Optional, defaults to `[]` |
