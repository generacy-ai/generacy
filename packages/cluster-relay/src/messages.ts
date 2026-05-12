import { z } from 'zod';

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
  channel: string;
  event: unknown;
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

export type RelayMessage =
  | ApiRequestMessage
  | ApiResponseMessage
  | EventMessage
  | ConversationMessage
  | HeartbeatMessage
  | HandshakeMessage
  | ErrorMessage
  | TunnelOpenMessage
  | TunnelOpenAckMessage
  | TunnelDataMessage
  | TunnelCloseMessage;

export interface GitRemote {
  name: string;
  url: string;
}

export interface ClusterMetadata {
  workerCount: number;
  activeWorkflows: number;
  channel: 'preview' | 'stable';
  orchestratorVersion: string;
  gitRemotes: GitRemote[];
  uptime: number;
  codeServerReady?: boolean;
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
  workerCount: z.number(),
  activeWorkflows: z.number(),
  channel: z.enum(['preview', 'stable']),
  orchestratorVersion: z.string(),
  gitRemotes: z.array(GitRemoteSchema),
  uptime: z.number(),
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

const EventMessageSchema = z.object({
  type: z.literal('event'),
  channel: z.string().min(1),
  event: z.unknown(),
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

export const RelayMessageSchema = z.discriminatedUnion('type', [
  ApiRequestMessageSchema,
  ApiResponseMessageSchema,
  EventMessageSchema,
  ConversationMessageSchema,
  HeartbeatMessageSchema,
  HandshakeMessageSchema,
  ErrorMessageSchema,
  TunnelOpenMessageSchema,
  TunnelOpenAckMessageSchema,
  TunnelDataMessageSchema,
  TunnelCloseMessageSchema,
]);

export { ClusterMetadataSchema, GitRemoteSchema };

/**
 * Parse and validate an incoming relay message.
 * Returns the validated message or null if invalid.
 */
export function parseRelayMessage(data: unknown): RelayMessage | null {
  const result = RelayMessageSchema.safeParse(data);
  return result.success ? (result.data as RelayMessage) : null;
}
