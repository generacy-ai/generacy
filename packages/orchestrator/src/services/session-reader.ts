import { z } from 'zod';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Zod Schemas (validation)
// ---------------------------------------------------------------------------

export const SessionParamsSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

export const SessionQuerySchema = z.object({
  workspace: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Content Block types
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Session message (response)
// ---------------------------------------------------------------------------

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool_result';
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  content: ContentBlock[];
  model?: string;
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  sessionId: string;
  slug: string | null;
  branch: string | null;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  messageCount: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Top-level response
// ---------------------------------------------------------------------------

export interface SessionResponse {
  metadata: SessionMetadata;
  messages: SessionMessage[];
}

// ---------------------------------------------------------------------------
// JSONL entry (internal)
// ---------------------------------------------------------------------------

interface JsonlEntry {
  type: 'user' | 'assistant' | 'queue-operation' | 'last-prompt';
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  slug?: string;
  gitBranch?: string;
  message: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
}

// ---------------------------------------------------------------------------
// SessionReader service
// ---------------------------------------------------------------------------

export class SessionReader {
  private readonly projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  }

  /**
   * Find the JSONL file for a session.
   *
   * With workspace: encode path (/ → -), look in specific directory.
   * Without workspace: scan all subdirectories for matching file.
   */
  async findSessionFile(
    sessionId: string,
    workspace?: string,
    workspaces?: Record<string, string>,
  ): Promise<string> {
    if (workspace) {
      if (!workspaces || !workspaces[workspace]) {
        const available = workspaces ? Object.keys(workspaces).join(', ') : 'none';
        const error = new Error(`Unknown workspace "${workspace}". Available: ${available}`);
        (error as any).statusCode = 400;
        throw error;
      }
      const workspacePath = workspaces[workspace];
      const encoded = workspacePath.replace(/\//g, '-');
      const filePath = join(this.projectsDir, encoded, `${sessionId}.jsonl`);

      try {
        await readFile(filePath, 'utf-8');
        return filePath;
      } catch {
        const error = new Error(`Session ${sessionId} not found`);
        (error as any).statusCode = 404;
        throw error;
      }
    }

    // No workspace — scan all subdirectories
    try {
      const dirs = await readdir(this.projectsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const filePath = join(this.projectsDir, dir.name, `${sessionId}.jsonl`);
        try {
          await readFile(filePath, 'utf-8');
          return filePath;
        } catch {
          // Not in this directory, continue
        }
      }
    } catch {
      const error = new Error('Failed to read session data');
      (error as any).statusCode = 500;
      throw error;
    }

    const error = new Error(`Session ${sessionId} not found`);
    (error as any).statusCode = 404;
    throw error;
  }

  /**
   * Parse a JSONL session file into structured messages + metadata.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<SessionResponse> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      const error = new Error('Failed to read session data');
      (error as any).statusCode = 500;
      throw error;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const messages: SessionMessage[] = [];
    let slug: string | null = null;
    let branch: string | null = null;
    let model: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const line of lines) {
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        // Skip corrupted lines
        continue;
      }

      // Filter out non-message types
      if (entry.type === 'queue-operation' || entry.type === 'last-prompt') {
        continue;
      }

      if (entry.type === 'assistant') {
        // Extract metadata from first assistant entry
        if (slug === null && entry.slug) slug = entry.slug;
        if (branch === null && entry.gitBranch) branch = entry.gitBranch;
        if (model === null && entry.message.model) model = entry.message.model;

        // Accumulate token usage
        if (entry.message.usage) {
          totalInputTokens += entry.message.usage.input_tokens ?? 0;
          totalOutputTokens += entry.message.usage.output_tokens ?? 0;
        }

        const contentBlocks = normalizeContent(entry.message.content);
        messages.push({
          role: 'assistant',
          uuid: entry.uuid,
          parentUuid: entry.parentUuid,
          timestamp: entry.timestamp,
          content: contentBlocks,
          model: entry.message.model,
          usage: entry.message.usage,
        });
      } else if (entry.type === 'user') {
        const contentBlocks = normalizeContent(entry.message.content);

        // Check for tool_result blocks — promote each to a separate message
        const textBlocks: ContentBlock[] = [];
        const toolResultBlocks: ToolResultBlock[] = [];

        for (const block of contentBlocks) {
          if (block.type === 'tool_result') {
            toolResultBlocks.push(block);
          } else {
            textBlocks.push(block);
          }
        }

        // Emit user message with non-tool_result blocks (if any)
        if (textBlocks.length > 0) {
          messages.push({
            role: 'user',
            uuid: entry.uuid,
            parentUuid: entry.parentUuid,
            timestamp: entry.timestamp,
            content: textBlocks,
          });
        }

        // Emit separate tool_result messages
        for (const toolResult of toolResultBlocks) {
          messages.push({
            role: 'tool_result',
            uuid: entry.uuid,
            parentUuid: entry.parentUuid,
            timestamp: entry.timestamp,
            content: [toolResult],
          });
        }
      }
    }

    return {
      metadata: {
        sessionId,
        slug,
        branch,
        model,
        totalInputTokens,
        totalOutputTokens,
        messageCount: messages.length,
        isActive: false, // Caller sets this from ConversationManager
      },
      messages,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}
