# Data Model: #519 Cluster-Side IDE Tunnel Support

## New Message Types (cluster-relay)

**File**: `packages/cluster-relay/src/messages.ts`

### TunnelOpenMessage

```typescript
export interface TunnelOpenMessage {
  type: 'tunnel_open';
  tunnelId: string;  // unique per tunnel session
  target: string;    // Unix socket path (restricted to /run/code-server.sock)
}
```

Zod schema:
```typescript
const TunnelOpenMessageSchema = z.object({
  type: z.literal('tunnel_open'),
  tunnelId: z.string().min(1),
  target: z.string().min(1),
});
```

### TunnelOpenAckMessage

```typescript
export interface TunnelOpenAckMessage {
  type: 'tunnel_open_ack';
  tunnelId: string;
  status: 'ok' | 'error';
  error?: string;  // present when status === 'error'
}
```

Zod schema:
```typescript
const TunnelOpenAckMessageSchema = z.object({
  type: z.literal('tunnel_open_ack'),
  tunnelId: z.string().min(1),
  status: z.enum(['ok', 'error']),
  error: z.string().optional(),
});
```

### TunnelDataMessage

```typescript
export interface TunnelDataMessage {
  type: 'tunnel_data';
  tunnelId: string;
  data: string;  // base64-encoded bytes
}
```

Zod schema:
```typescript
const TunnelDataMessageSchema = z.object({
  type: z.literal('tunnel_data'),
  tunnelId: z.string().min(1),
  data: z.string().min(1),
});
```

### TunnelCloseMessage

```typescript
export interface TunnelCloseMessage {
  type: 'tunnel_close';
  tunnelId: string;
  reason?: string;
}
```

Zod schema:
```typescript
const TunnelCloseMessageSchema = z.object({
  type: z.literal('tunnel_close'),
  tunnelId: z.string().min(1),
  reason: z.string().optional(),
});
```

### Updated RelayMessage Union

```diff
 export type RelayMessage =
   | ApiRequestMessage
   | ApiResponseMessage
   | EventMessage
   | ConversationMessage
   | HeartbeatMessage
   | HandshakeMessage
-  | ErrorMessage;
+  | ErrorMessage
+  | TunnelOpenMessage
+  | TunnelOpenAckMessage
+  | TunnelDataMessage
+  | TunnelCloseMessage;
```

```diff
 export const RelayMessageSchema = z.discriminatedUnion('type', [
   ApiRequestMessageSchema,
   ApiResponseMessageSchema,
   EventMessageSchema,
   ConversationMessageSchema,
   HeartbeatMessageSchema,
   HandshakeMessageSchema,
   ErrorMessageSchema,
+  TunnelOpenMessageSchema,
+  TunnelOpenAckMessageSchema,
+  TunnelDataMessageSchema,
+  TunnelCloseMessageSchema,
 ]);
```

## New Service Types (control-plane)

**File**: `packages/control-plane/src/services/tunnel-handler.ts`

### RelayMessageSender

```typescript
export interface RelayMessageSender {
  send(message: unknown): void;
}
```

Minimal interface for dependency injection. The orchestrator provides `relay.send.bind(relay)`. Using `unknown` for the message type avoids coupling control-plane to cluster-relay's `RelayMessage` type.

### TunnelHandler

```typescript
export class TunnelHandler {
  private tunnels: Map<string, net.Socket>;

  constructor(
    relaySend: RelayMessageSender,
    codeServerManager: CodeServerManager,
    allowedTarget?: string,  // default: '/run/code-server.sock'
  );

  handleOpen(msg: { tunnelId: string; target: string }): Promise<void>;
  handleData(msg: { tunnelId: string; data: string }): void;
  handleClose(msg: { tunnelId: string; reason?: string }): void;
  cleanup(): void;
}
```

## Orchestrator Relay Types Extension

**File**: `packages/orchestrator/src/types/relay.ts`

```diff
 export type RelayMessage =
   | RelayApiRequest
   | RelayApiResponse
   | RelayEvent
   | RelayJobEvent
   | RelayMetadata
   | RelayConversationInput
   | RelayConversationOutput
   | RelayLeaseRequest
   | RelayLeaseGranted
   | RelayLeaseDenied
   | RelayLeaseRelease
   | RelayLeaseHeartbeat
   | RelaySlotAvailable
   | RelayTierInfo
-  | RelayClusterRejected;
+  | RelayClusterRejected
+  | RelayTunnelOpen
+  | RelayTunnelOpenAck
+  | RelayTunnelData
+  | RelayTunnelClose;
```

New interfaces:
```typescript
export interface RelayTunnelOpen {
  type: 'tunnel_open';
  tunnelId: string;
  target: string;
}

export interface RelayTunnelOpenAck {
  type: 'tunnel_open_ack';
  tunnelId: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface RelayTunnelData {
  type: 'tunnel_data';
  tunnelId: string;
  data: string;
}

export interface RelayTunnelClose {
  type: 'tunnel_close';
  tunnelId: string;
  reason?: string;
}
```

## Internal State: TunnelHandler.tunnels Map

```
Key:   tunnelId (string)
Value: net.Socket (connected to /run/code-server.sock)
```

Lifecycle:
- **Created**: On successful `handleOpen` — socket connected to target
- **Used**: On `handleData` — data written to socket; on socket `data` event — base64 encoded and sent via relay
- **Destroyed**: On `handleClose`, on socket error/close event, or on `cleanup()`

No persistence — map is cleared on relay disconnect (stateless across reconnects per Q4).

## Message Flow

```
Browser Tab (IDE)
  │
  ▼ WebSocket
Cloud TunnelManager
  │
  ▼ tunnel_open { tunnelId, target: '/run/code-server.sock' }
Relay WebSocket
  │
  ▼ parsed by RelayMessageSchema (FR-001)
ClusterRelay → RelayBridge.handleMessage() (FR-002)
  │
  ▼ dispatched to TunnelHandler.handleOpen()
TunnelHandler (FR-003)
  │
  ├─► CodeServerManager.start()  (FR-005, if not running)
  ├─► net.createConnection('/run/code-server.sock')
  └─► relay.send(tunnel_open_ack { status: 'ok' })
      │
      ▼ bidirectional data flow
  tunnel_data (cloud→cluster): base64 decode → socket.write()
  socket 'data' event (cluster→cloud): base64 encode → relay.send(tunnel_data)
  CodeServerManager.touch() on each inbound tunnel_data (FR-006)
      │
      ▼ on close
  tunnel_close (from cloud): socket.destroy(), remove from map
  socket 'close' (from code-server): relay.send(tunnel_close), remove from map (FR-007)
```
