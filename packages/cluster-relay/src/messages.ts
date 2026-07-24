import { z } from 'zod';
import { GateTypeSchema, type GateType } from '@generacy-ai/cockpit';

// --- Interfaces ---

export interface ApiRequestMessage {
  type: 'api_request';
  correlationId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  actor?: Actor;
}

export interface ApiResponseMessage {
  type: 'api_response';
  correlationId: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface EventMessage {
  type: 'event';
  event: string;
  data: unknown;
  timestamp: string;
}

export interface ConversationInputMessage {
  type: 'conversation';
  conversationId: string;
  data: {
    action: 'message';
    content: string;
  };
}

export interface ConversationOutputMessage {
  type: 'conversation';
  conversationId: string;
  data: {
    event: 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error';
    payload: unknown;
    timestamp: string;
  };
}

export type ConversationMessage = ConversationInputMessage | ConversationOutputMessage;

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export interface HandshakeMessage {
  type: 'handshake';
  metadata: ClusterMetadata;
  activation?: Activation;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface TunnelOpenMessage {
  type: 'tunnel_open';
  tunnelId: string;
  target: string;
}

export interface TunnelOpenAckMessage {
  type: 'tunnel_open_ack';
  tunnelId: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface TunnelDataMessage {
  type: 'tunnel_data';
  tunnelId: string;
  data: string;
}

export interface TunnelCloseMessage {
  type: 'tunnel_close';
  tunnelId: string;
  reason?: string;
}

// --- Lease protocol messages (#418 / #1016) ---
// Wire shapes mirror generacy-cloud services/api/src/services/relay/relay-types.ts.
// Cluster → cloud: lease_request / lease_release / lease_heartbeat.
// Cloud → cluster: lease_response / slot_available / cluster_rejected / tier_info.

export interface LeaseRequestMessage {
  type: 'lease_request';
  correlationId: string;
  queueItemId: string;
  jobId: string;
  userId?: string;
}

export interface LeaseReleaseMessage {
  type: 'lease_release';
  correlationId: string;
  leaseId: string;
}

export interface LeaseHeartbeatMessage {
  type: 'lease_heartbeat';
  leaseId: string;
}

export interface LeaseResponseMessage {
  type: 'lease_response';
  correlationId: string;
  status: 'granted' | 'denied' | 'released' | 'error';
  leaseId?: string;
  ttlSeconds?: number;
  reason?: string;
  currentCount?: number;
  limit?: number;
  message?: string;
}

export interface SlotAvailableMessage {
  type: 'slot_available';
  userId: string;
  orgId?: string;
  timestamp?: string;
  availableSlots?: number;
}

export interface ClusterRejectedMessage {
  type: 'cluster_rejected';
  reason: string;
  currentLimit?: number;
  tierName?: string;
  upgradeHint?: string;
}

export interface TierInfoMessage {
  type: 'tier_info';
  tier: string;
  maxConcurrentWorkflows: number;
  maxActiveClusters?: number;
}

// --- Gate query envelope pair (#1038) ---
// Cluster → cloud: gate_query_request (single or list mode)
// Cloud → cluster: gate_query_response (echoes correlationId; ok payload or error)
// Wire contract: specs/1038-part-cockpit-remote-gates/contracts/gate-query-relay-envelope.md

export interface GateQueryRequestMessage {
  type: 'gate_query_request';
  correlationId: string;
  issueRef: string;
  mode: 'single' | 'list';
  gateType?: GateType;
  generation?: string | number;
  gateTypeFilter?: GateType;
}

export interface GateQueryResponseSinglePayload {
  mode: 'single';
  gateId: string;
  status: 'open' | 'answered' | 'absent';
}

export interface GateQueryResponseListPayload {
  mode: 'list';
  gates: Array<{
    gateId: string;
    gateType: GateType;
    status: 'open' | 'answered';
  }>;
}

export interface GateQueryResponseMessage {
  type: 'gate_query_response';
  correlationId: string;
  status: 'ok' | 'error';
  payload?: GateQueryResponseSinglePayload | GateQueryResponseListPayload;
  error?: string;
}

export type RelayMessage =
  | ApiRequestMessage
  | ApiResponseMessage
  | EventMessage
  | ConversationMessage
  | HeartbeatMessage
  | HandshakeMessage
  | ErrorMessage
  | LeaseRequestMessage
  | LeaseReleaseMessage
  | LeaseHeartbeatMessage
  | LeaseResponseMessage
  | SlotAvailableMessage
  | ClusterRejectedMessage
  | TierInfoMessage
  | TunnelOpenMessage
  | TunnelOpenAckMessage
  | TunnelDataMessage
  | TunnelCloseMessage
  | GateQueryRequestMessage
  | GateQueryResponseMessage;

export interface GitRemote {
  name: string;
  url: string;
}

export interface ClusterMetadata {
  workers: number;
  activeWorkflows: number;
  channel: 'preview' | 'stable';
  orchestratorVersion: string;
  gitRemotes: GitRemote[];
  uptime: number;
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  postActivationReady?: boolean;
  displayName?: string;
  clusterId?: string;
}

// --- Zod Schemas ---

export const ActorSchema = z.object({
  userId: z.string(),
  sessionId: z.string().optional(),
});

export const ActivationSchema = z.object({
  code: z.string(),
  clusterApiKeyId: z.string().optional(),
});

export type Actor = z.infer<typeof ActorSchema>;
export type Activation = z.infer<typeof ActivationSchema>;

const GitRemoteSchema = z.object({
  name: z.string(),
  url: z.string(),
});

const ClusterMetadataSchema = z.object({
  workers: z.number(),
  activeWorkflows: z.number(),
  channel: z.enum(['preview', 'stable']),
  orchestratorVersion: z.string(),
  gitRemotes: z.array(GitRemoteSchema),
  uptime: z.number(),
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
});

const ApiRequestMessageSchema = z.object({
  type: z.literal('api_request'),
  correlationId: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timestamp: z.string().optional(),
  actor: ActorSchema.optional(),
});

const ApiResponseMessageSchema = z.object({
  type: z.literal('api_response'),
  correlationId: z.string().min(1),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timestamp: z.string().optional(),
});

export const EventMessageSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  data: z.unknown(),
  timestamp: z.string().datetime(),
});

const ConversationInputDataSchema = z.object({
  action: z.literal('message'),
  content: z.string().min(1),
});

const ConversationOutputDataSchema = z.object({
  event: z.enum(['output', 'tool_use', 'tool_result', 'complete', 'error']),
  payload: z.unknown(),
  timestamp: z.string(),
});

const ConversationMessageSchema = z.object({
  type: z.literal('conversation'),
  conversationId: z.string().min(1),
  data: z.union([ConversationInputDataSchema, ConversationOutputDataSchema]),
});

const HeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
});

const HandshakeMessageSchema = z.object({
  type: z.literal('handshake'),
  metadata: ClusterMetadataSchema,
  activation: ActivationSchema.optional(),
});

const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

const TunnelOpenMessageSchema = z.object({
  type: z.literal('tunnel_open'),
  tunnelId: z.string().min(1),
  target: z.string().min(1),
});

const TunnelOpenAckMessageSchema = z.object({
  type: z.literal('tunnel_open_ack'),
  tunnelId: z.string().min(1),
  status: z.enum(['ok', 'error']),
  error: z.string().optional(),
});

const TunnelDataMessageSchema = z.object({
  type: z.literal('tunnel_data'),
  tunnelId: z.string().min(1),
  data: z.string().min(1),
});

const TunnelCloseMessageSchema = z.object({
  type: z.literal('tunnel_close'),
  tunnelId: z.string().min(1),
  reason: z.string().optional(),
});

const LeaseRequestMessageSchema = z.object({
  type: z.literal('lease_request'),
  correlationId: z.string().min(1),
  queueItemId: z.string().min(1),
  jobId: z.string().min(1),
  userId: z.string().optional(),
});

const LeaseReleaseMessageSchema = z.object({
  type: z.literal('lease_release'),
  correlationId: z.string().min(1),
  leaseId: z.string().min(1),
});

const LeaseHeartbeatMessageSchema = z.object({
  type: z.literal('lease_heartbeat'),
  leaseId: z.string().min(1),
});

const LeaseResponseMessageSchema = z.object({
  type: z.literal('lease_response'),
  correlationId: z.string().min(1),
  status: z.enum(['granted', 'denied', 'released', 'error']),
  leaseId: z.string().optional(),
  ttlSeconds: z.number().optional(),
  reason: z.string().optional(),
  currentCount: z.number().optional(),
  limit: z.number().optional(),
  message: z.string().optional(),
});

const SlotAvailableMessageSchema = z.object({
  type: z.literal('slot_available'),
  userId: z.string().min(1),
  orgId: z.string().optional(),
  timestamp: z.string().optional(),
  availableSlots: z.number().optional(),
});

const ClusterRejectedMessageSchema = z.object({
  type: z.literal('cluster_rejected'),
  reason: z.string(),
  currentLimit: z.number().optional(),
  tierName: z.string().optional(),
  upgradeHint: z.string().optional(),
});

const TierInfoMessageSchema = z.object({
  type: z.literal('tier_info'),
  tier: z.string(),
  maxConcurrentWorkflows: z.number(),
  maxActiveClusters: z.number().optional(),
});

const GateQueryRequestMessageSchema = z.object({
  type: z.literal('gate_query_request'),
  correlationId: z.string().min(1),
  issueRef: z.string().min(1),
  mode: z.enum(['single', 'list']),
  gateType: GateTypeSchema.optional(),
  generation: z.union([z.string().min(1), z.number()]).optional(),
  gateTypeFilter: GateTypeSchema.optional(),
});

const GateQueryResponseSinglePayloadSchema = z.object({
  mode: z.literal('single'),
  gateId: z.string().length(24),
  status: z.enum(['open', 'answered', 'absent']),
});

const GateQueryResponseListPayloadSchema = z.object({
  mode: z.literal('list'),
  gates: z.array(
    z.object({
      gateId: z.string().length(24),
      gateType: GateTypeSchema,
      status: z.enum(['open', 'answered']),
    }),
  ),
});

const GateQueryResponseMessageSchema = z.object({
  type: z.literal('gate_query_response'),
  correlationId: z.string().min(1),
  status: z.enum(['ok', 'error']),
  payload: z
    .union([GateQueryResponseSinglePayloadSchema, GateQueryResponseListPayloadSchema])
    .optional(),
  error: z.string().optional(),
});

export const RelayMessageSchema = z.discriminatedUnion('type', [
  ApiRequestMessageSchema,
  ApiResponseMessageSchema,
  EventMessageSchema,
  ConversationMessageSchema,
  HeartbeatMessageSchema,
  HandshakeMessageSchema,
  ErrorMessageSchema,
  LeaseRequestMessageSchema,
  LeaseReleaseMessageSchema,
  LeaseHeartbeatMessageSchema,
  LeaseResponseMessageSchema,
  SlotAvailableMessageSchema,
  ClusterRejectedMessageSchema,
  TierInfoMessageSchema,
  TunnelOpenMessageSchema,
  TunnelOpenAckMessageSchema,
  TunnelDataMessageSchema,
  TunnelCloseMessageSchema,
  GateQueryRequestMessageSchema,
  GateQueryResponseMessageSchema,
]);

export { GateQueryRequestMessageSchema, GateQueryResponseMessageSchema };

export { ClusterMetadataSchema, GitRemoteSchema };

/**
 * Parse and validate an incoming relay message.
 * Returns the validated message or null if invalid.
 */
export function parseRelayMessage(data: unknown): RelayMessage | null {
  const result = RelayMessageSchema.safeParse(data);
  if (!result.success) return null;
  const msg = result.data as RelayMessage;
  // Cross-field rule for gate_query_response: status='ok' MUST have a payload.
  // Enforced here (not on the object schema) so the schema stays discriminated-union-friendly.
  if (
    msg.type === 'gate_query_response' &&
    msg.status === 'ok' &&
    msg.payload === undefined
  ) {
    return null;
  }
  return msg;
}
