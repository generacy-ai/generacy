# Data Model: Background Activation in Wizard Mode

**Branch**: `567-problem-wizard-mode-generacy` | **Date**: 2026-05-11

## No New Types

This fix does not introduce new data types, schemas, or entities. It restructures control flow within `createServer()` using existing types.

## Existing Types (unchanged, referenced)

### ActivationResult (packages/orchestrator/src/activation/types.ts)

```typescript
interface ActivationResult {
  apiKey: string;
  clusterApiKeyId?: string;
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl?: string;
}
```

Used by the background activation function to update `config.relay` after success.

### OrchestratorConfig (packages/orchestrator/src/config/index.ts)

Key fields mutated by activation:
- `config.relay.apiKey` — set from `activationResult.apiKey`
- `config.relay.clusterApiKeyId` — set from `activationResult.clusterApiKeyId`
- `config.relay.cloudUrl` — derived from `activationResult.cloudUrl`
- `config.activation.cloudUrl` — updated from `activationResult.cloudUrl`

These mutations happen asynchronously in the background path instead of synchronously.

## Function Signatures (new)

### initializeRelayBridge

```typescript
async function initializeRelayBridge(
  config: OrchestratorConfig,
  server: FastifyInstance,
  apiKeyStore: InMemoryApiKeyStore,
): Promise<{
  relayBridge: RelayBridge | null;
  statusReporter: StatusReporter;
}>
```

Extracted from server.ts lines 334-392. Pure extraction — no logic changes.

### initializeConversationManager

```typescript
async function initializeConversationManager(
  config: OrchestratorConfig,
  server: FastifyInstance,
  relayBridge: RelayBridge | null,
): Promise<ConversationManager | null>
```

Extracted from server.ts lines 394-427. Pure extraction — no logic changes.

## State Lifecycle

```
createServer() scope:
  let relayBridge: RelayBridge | null = null;
  let conversationManager: ConversationManager | null = null;

  // Sync path (apiKey exists): assigned during createServer()
  // Async path (wizard mode): assigned by background function after activation
  // Either way: shutdown cleanup closure captures by reference
```
