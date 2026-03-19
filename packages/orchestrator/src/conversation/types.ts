import { z } from 'zod';
import type { ChildProcessHandle } from '../worker/types.js';

// =============================================================================
// State
// =============================================================================

export type ConversationState = 'starting' | 'active' | 'ending' | 'ended';

// =============================================================================
// Core Entities
// =============================================================================

/**
 * Internal handle tracking an active conversation process.
 */
export interface ConversationHandle {
  conversationId: string;
  workingDirectory: string;
  workspaceId: string;
  skipPermissions: boolean;
  sessionId?: string;
  process: ChildProcessHandle;
  startedAt: string;
  model?: string;
  initialCommand?: string;
  state: ConversationState;
  /** Writable stream for sending messages to the CLI process stdin */
  stdin: NodeJS.WritableStream | null;
}

/**
 * Public-facing conversation metadata (returned by API).
 */
export interface ConversationInfo {
  conversationId: string;
  workspaceId: string;
  sessionId?: string;
  model?: string;
  skipPermissions: boolean;
  startedAt: string;
  state: ConversationState;
}

/**
 * Options for starting a new conversation.
 */
export interface ConversationStartOptions {
  conversationId: string;
  workingDirectory: string;
  initialCommand?: string;
  model?: string;
  skipPermissions?: boolean;
}

// =============================================================================
// Zod Schemas (request validation)
// =============================================================================

export const ConversationStartSchema = z.object({
  conversationId: z.string().min(1).max(128),
  workingDirectory: z.string().min(1).max(64),
  initialCommand: z.string().max(4096).optional(),
  model: z.string().max(64).optional(),
  skipPermissions: z.boolean().default(true),
});

export const ConversationMessageSchema = z.object({
  message: z.string().min(1).max(65536),
});

// =============================================================================
// Relay Message Schemas
// =============================================================================

export const ConversationRelayInputSchema = z.object({
  action: z.literal('message'),
  content: z.string().min(1).max(65536),
});

export type ConversationRelayInput = z.infer<typeof ConversationRelayInputSchema>;

export const ConversationRelayOutputSchema = z.object({
  event: z.enum(['output', 'tool_use', 'tool_result', 'complete', 'error']),
  payload: z.unknown(),
  timestamp: z.string().datetime(),
});

export type ConversationRelayOutput = z.infer<typeof ConversationRelayOutputSchema>;

// =============================================================================
// Output Event Types
// =============================================================================

export type ConversationEventType = 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error';

/**
 * A parsed output event from the Claude CLI process.
 */
export interface ConversationOutputEvent {
  event: ConversationEventType;
  payload: unknown;
  timestamp: string;
}

/**
 * Callback for receiving conversation output events.
 */
export type ConversationOutputCallback = (
  conversationId: string,
  event: ConversationOutputEvent,
) => void;
