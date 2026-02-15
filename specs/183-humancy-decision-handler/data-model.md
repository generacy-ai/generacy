# Data Model: HumancyApiDecisionHandler

**Branch**: `183-humancy-decision-handler` | **Date**: 2026-02-15

## New Types

### HumancyApiHandlerConfig

Handler configuration, passed at construction time.

```typescript
// File: packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts

export interface HumancyApiHandlerConfig {
  /** Base URL for the orchestrator API (e.g., http://localhost:3200) */
  apiUrl: string;
  /** Agent ID for decision attribution */
  agentId: string;
  /** Optional project ID for scoping decisions */
  projectId?: string;
  /** Optional auth token for API requests */
  authToken?: string;
  /** Whether to fall back to simulation on API failure (default: true) */
  fallbackToSimulation?: boolean;
  /** SSE reconnection delay in ms (default: 1000) */
  sseReconnectDelay?: number;
  /** Maximum SSE reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Optional logger */
  logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
}
```

### CreateDecisionRequest (Orchestrator)

New Zod schema for `POST /queue` request body.

```typescript
// File: packages/orchestrator/src/types/api.ts

export const CreateDecisionRequestSchema = z.object({
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  type: DecisionTypeSchema,
  prompt: z.string().min(1),
  options: z.array(DecisionOptionSchema).optional(),
  context: z.record(z.unknown()).default({}),
  priority: DecisionPrioritySchema.default('when_available'),
  expiresAt: z.string().datetime().nullable().optional(),
  agentId: z.string().optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequestSchema>;
```

### CorrelationTimeoutError

```typescript
// File: packages/workflow-engine/src/errors/correlation-timeout.ts

export class CorrelationTimeoutError extends Error {
  constructor(message: string, public readonly decisionId?: string) {
    super(message);
    this.name = 'CorrelationTimeoutError';
  }
}
```

## Modified Types

### DecisionQueueItemSchema (Relaxed)

```diff
// File: packages/orchestrator/src/types/api.ts

 export const DecisionQueueItemSchema = z.object({
   id: z.string().uuid(),
-  workflowId: z.string().uuid(),
+  workflowId: z.string().min(1),
   stepId: z.string(),
   type: DecisionTypeSchema,
   prompt: z.string(),
   options: z.array(DecisionOptionSchema).optional(),
   context: z.record(z.unknown()),
   priority: DecisionPrioritySchema,
   createdAt: z.string().datetime(),
   expiresAt: z.string().datetime().nullable().optional(),
 });
```

### QueueQuerySchema (Relaxed)

```diff
// File: packages/orchestrator/src/types/api.ts

 export const QueueQuerySchema = z.object({
   priority: DecisionPrioritySchema.optional(),
-  workflowId: z.string().uuid().optional(),
+  workflowId: z.string().optional(),
 });
```

### QueueEventData (Extended)

```diff
// File: packages/orchestrator/src/types/sse.ts

+import type { DecisionResponse } from './api.js';
+
 export interface QueueEventData {
   action: 'added' | 'removed' | 'updated';
   item?: DecisionQueueItem;
   items?: DecisionQueueItem[];
   queueSize: number;
+  response?: DecisionResponse;
 }
```

### MessageRouter (Extended)

```diff
// File: packages/orchestrator/src/services/queue-service.ts

 export interface MessageRouter {
   getQueue(query?: QueueQuery): Promise<DecisionQueueItem[]>;
   getDecision(id: string): Promise<DecisionQueueItem | null>;
   respondToDecision(id: string, response: DecisionResponseRequest, respondedBy: string): Promise<DecisionResponse>;
+  createDecision(request: CreateDecisionRequest): Promise<DecisionQueueItem>;
 }
```

### JobHandlerOptions (Extended)

```diff
// File: packages/generacy/src/orchestrator/job-handler.ts

 export interface JobHandlerOptions {
   client: OrchestratorClient;
   workerId: string;
   pollInterval?: number;
   logger: Logger;
   workdir?: string;
   capabilities?: string[];
   onJobStart?: (job: Job) => void;
   onJobComplete?: (job: Job, result: JobResult) => void;
   onError?: (error: Error, job?: Job) => void;
+  /** Optional human decision handler for Humancy integration */
+  humanDecisionHandler?: HumanDecisionHandler;
 }
```

## Type Mapping Tables

### Request: ReviewDecisionRequest → CreateDecisionRequest

| Source (ReviewDecisionRequest) | Target (CreateDecisionRequest) | Transformation |
|---|---|---|
| `type: 'review'` | `type: 'review'` | Direct |
| `title` | `prompt` | Direct |
| `description` | `context.description` | Nested in context |
| `options[].id` | `options[].id` | Direct |
| `options[].label` | `options[].label` | Direct |
| `options[].requiresComment` | `options[].description` | `requiresComment ? 'Comment required' : undefined` |
| `artifact` | `context.artifact` | Nested in context |
| `workflowId` | `workflowId` | Direct |
| `stepId` | `stepId` | Direct |
| `urgency: 'low'` | `priority: 'when_available'` | Mapped |
| `urgency: 'normal'` | `priority: 'when_available'` | Mapped |
| `urgency: 'blocking_soon'` | `priority: 'blocking_soon'` | Direct |
| `urgency: 'blocking_now'` | `priority: 'blocking_now'` | Direct |
| *(from config)* | `agentId` | From `config.agentId` |
| *(from timeout)* | `expiresAt` | `new Date(Date.now() + timeout + 300000).toISOString()` |

### Urgency → Priority Map

```typescript
const URGENCY_TO_PRIORITY: Record<HumancyUrgency, DecisionPriority> = {
  low: 'when_available',
  normal: 'when_available',
  blocking_soon: 'blocking_soon',
  blocking_now: 'blocking_now',
};
```

### Response: DecisionResponse → ReviewDecisionResponse

| Source (DecisionResponse) | Target (ReviewDecisionResponse) | Transformation |
|---|---|---|
| `response: true` | `approved: true` | Boolean → approved |
| `response: false` | `approved: false` | Boolean → rejected |
| `response: string` | `approved: (str === firstOptionId)`, `decision: string` | First option convention |
| `response: string[]` | `approved: (arr[0] === firstOptionId)`, `decision: arr[0]` | First element, first option |
| `comment` | `input` | Rename |
| `respondedBy` | `respondedBy` | Direct |
| `respondedAt` | `respondedAt` | Direct |

### Response Mapping Logic

```typescript
function mapResponse(
  orchestratorResponse: DecisionResponse,
  firstOptionId?: string
): ReviewDecisionResponse {
  const { response, comment, respondedBy, respondedAt } = orchestratorResponse;

  let approved: boolean | undefined;
  let decision: string | undefined;

  if (typeof response === 'boolean') {
    approved = response;
  } else if (typeof response === 'string') {
    decision = response;
    approved = firstOptionId ? response === firstOptionId : undefined;
  } else if (Array.isArray(response)) {
    decision = response[0];
    approved = firstOptionId ? response[0] === firstOptionId : undefined;
  }

  return {
    approved,
    decision,
    input: comment,
    respondedBy,
    respondedAt,
  };
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HUMANCY_API_URL` | No | *(none — simulation mode)* | Orchestrator base URL for queue API |
| `HUMANCY_AGENT_ID` | No | Worker ID | Agent ID for decision attribution |
| `HUMANCY_AUTH_TOKEN` | No | `ORCHESTRATOR_TOKEN` | Auth token for queue API requests |
