import { z } from 'zod';

// --- Interfaces ---

export interface ApiRequestMessage {
  type: 'api_request';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApiResponseMessage {
  type: 'api_response';
  id: string;
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
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type RelayMessage =
  | ApiRequestMessage
  | ApiResponseMessage
  | EventMessage
  | ConversationMessage
  | HeartbeatMessage
  | HandshakeMessage
  | ErrorMessage;

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
}

// --- Zod Schemas ---

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
  id: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const ApiResponseMessageSchema = z.object({
  type: z.literal('api_response'),
  id: z.string().min(1),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
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
});

const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

export const RelayMessageSchema = z.discriminatedUnion('type', [
  ApiRequestMessageSchema,
  ApiResponseMessageSchema,
  EventMessageSchema,
  ConversationMessageSchema,
  HeartbeatMessageSchema,
  HandshakeMessageSchema,
  ErrorMessageSchema,
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
