import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OutputChunk, WorkflowPhase, JournalEntry } from './types.js';

/**
 * Buffers structured metadata entries and periodically flushes them
 * as JSONL to `specs/{issue-number}/conversation-log.jsonl`.
 *
 * Text content is never logged — only structural metadata (phase
 * boundaries, tool events, errors).
 */
export class ConversationLogger {
  static readonly FLUSH_EVENT_THRESHOLD = 50;
  static readonly FLUSH_INTERVAL_MS = 30_000;

  private readonly filePath: string;

  private currentPhase: WorkflowPhase | null = null;
  private sessionId = '';

  private buffer: JournalEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Maps toolCallId → Date.now() for duration calculation. */
  private toolStartTimes = new Map<string, number>();

  /** Token counts from the last `complete` event, included in phase_complete. */
  private lastTokensIn: number | undefined;
  private lastTokensOut: number | undefined;

  constructor(specDir: string) {
    this.filePath = `${specDir}/conversation-log.jsonl`;
  }

  /**
   * Begin a new phase. Emits a `phase_start` entry and starts the
   * periodic flush timer.
   */
  setPhase(phase: WorkflowPhase, sessionId: string, model?: string): void {
    this.currentPhase = phase;
    this.sessionId = sessionId;
    this.toolStartTimes.clear();

    this.pushEntry({
      event_type: 'phase_start',
      ...(model && { model }),
    });

    this.startFlushTimer();
  }

  /**
   * Process an OutputChunk from the CLI stream and convert relevant
   * events into JournalEntry objects.
   */
  logEvent(chunk: OutputChunk): void {
    if (this.currentPhase === null) {
      return;
    }

    const data = chunk.data as Record<string, unknown> | undefined;

    switch (chunk.type) {
      case 'tool_use': {
        const toolName = this.str(data, 'name');
        const toolCallId = this.str(data, 'id');
        const filePaths = this.extractFilePathsFromToolUse(toolName, data);

        if (toolCallId) {
          this.toolStartTimes.set(toolCallId, Date.now());
        }

        this.pushEntry({
          event_type: 'tool_use',
          ...(toolName && { tool_name: toolName }),
          ...(toolCallId && { tool_call_id: toolCallId }),
          ...(filePaths.length > 0 && { file_paths: filePaths }),
        });
        break;
      }

      case 'tool_result': {
        const toolName = this.str(data, 'name');
        const toolCallId = this.str(data, 'tool_use_id');
        const filePaths = chunk.metadata?.filePath ? [chunk.metadata.filePath] : [];

        let durationMs: number | undefined;
        if (toolCallId) {
          const startTime = this.toolStartTimes.get(toolCallId);
          if (startTime !== undefined) {
            durationMs = Date.now() - startTime;
            this.toolStartTimes.delete(toolCallId);
          }
        }

        this.pushEntry({
          event_type: 'tool_result',
          ...(toolName && { tool_name: toolName }),
          ...(toolCallId && { tool_call_id: toolCallId }),
          ...(filePaths.length > 0 && { file_paths: filePaths }),
          ...(durationMs != null && { duration_ms: durationMs }),
        });
        break;
      }

      case 'complete': {
        const usage = data?.usage as Record<string, unknown> | undefined;
        const tokensIn = this.num(usage, 'input_tokens');
        const tokensOut = this.num(usage, 'output_tokens');

        // Store token counts to include in phase_complete
        if (tokensIn != null) this.lastTokensIn = tokensIn;
        if (tokensOut != null) this.lastTokensOut = tokensOut;
        break;
      }

      case 'error': {
        const message = this.str(data, 'message')
          ?? this.str(data?.error as Record<string, unknown> | undefined, 'message');

        this.pushEntry({
          event_type: 'error',
          ...(message && { error_message: message }),
        });
        break;
      }

      case 'init': {
        // Update session_id from the actual CLI init event
        const initSessionId = this.str(data, 'session_id');
        if (initSessionId) this.sessionId = initSessionId;
        break;
      }

      // 'text' events are explicitly excluded from JSONL.
      default:
        break;
    }
  }

  /**
   * Serialize buffered entries as JSONL and append to file.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const entries = this.buffer;
    this.buffer = [];

    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, lines, 'utf-8');
  }

  /**
   * Emit `phase_complete`, perform final flush, and clean up.
   */
  async close(): Promise<void> {
    this.pushEntry({
      event_type: 'phase_complete',
      ...(this.lastTokensIn != null && { tokens_in: this.lastTokensIn }),
      ...(this.lastTokensOut != null && { tokens_out: this.lastTokensOut }),
    });

    await this.flush();

    this.stopFlushTimer();
    this.toolStartTimes.clear();
    this.lastTokensIn = undefined;
    this.lastTokensOut = undefined;
  }

  /** The path to the JSONL file (for git staging). */
  getFilePath(): string {
    return this.filePath;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pushEntry(fields: Omit<JournalEntry, 'timestamp' | 'phase' | 'session_id'>): void {
    if (this.currentPhase === null) {
      return;
    }

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      phase: this.currentPhase,
      session_id: this.sessionId,
      ...fields,
    };

    this.buffer.push(entry);

    if (this.buffer.length >= ConversationLogger.FLUSH_EVENT_THRESHOLD) {
      void this.flush();
    }
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, ConversationLogger.FLUSH_INTERVAL_MS);

    // Allow the Node process to exit even if the timer is active
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Best-effort extraction of file paths from tool_use input parameters.
   */
  private extractFilePathsFromToolUse(
    toolName: string | undefined,
    data: Record<string, unknown> | undefined,
  ): string[] {
    if (!toolName || !data) return [];

    const input = data.input as Record<string, unknown> | undefined;
    if (!input) return [];

    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit': {
        const fp = typeof input.file_path === 'string' ? input.file_path : undefined;
        return fp ? [fp] : [];
      }
      case 'Glob':
      case 'Grep': {
        const p = typeof input.path === 'string' ? input.path : undefined;
        return p ? [p] : [];
      }
      default:
        return [];
    }
  }

  /** Safely extract a string field. */
  private str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
    if (!obj) return undefined;
    return typeof obj[key] === 'string' ? (obj[key] as string) : undefined;
  }

  /** Safely extract a numeric field. */
  private num(obj: Record<string, unknown> | undefined, key: string): number | undefined {
    if (!obj) return undefined;
    return typeof obj[key] === 'number' ? (obj[key] as number) : undefined;
  }
}
