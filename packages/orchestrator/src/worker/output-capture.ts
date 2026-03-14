import type { OutputChunk, Logger, ImplementPartialResult } from './types.js';
import type { ConversationLogger } from './conversation-logger.js';

/**
 * Valid OutputChunk type values recognized from Claude CLI JSON output.
 */
const KNOWN_TYPES = new Set<OutputChunk['type']>([
  'init',
  'tool_use',
  'tool_result',
  'text',
  'complete',
  'error',
]);

/**
 * Callback for SSE event emission
 */
export type SSEEventEmitter = (event: {
  type: 'workflow:started' | 'step:started' | 'step:completed' | 'workflow:completed' | 'workflow:failed';
  workflowId: string;
  data: Record<string, unknown>;
}) => void;

/**
 * Parses newline-delimited JSON from Claude CLI stdout and emits SSE events.
 *
 * Claude CLI outputs one JSON object per line. This class accumulates raw
 * string chunks (which may arrive mid-line), splits on newline boundaries,
 * parses each complete line, and optionally emits SSE events for key
 * lifecycle moments.
 */
export class OutputCapture {
  private buffer: OutputChunk[] = [];
  private lineBuffer = '';

  /** Session ID extracted from the Claude CLI `init` event (if present). */
  private _sessionId: string | undefined;

  /** Implement partial result parsed from SPECKIT_IMPLEMENT_PARTIAL sentinel (if present). */
  private _implementResult: ImplementPartialResult | undefined;

  constructor(
    private readonly workflowId: string,
    private readonly logger: Logger,
    private readonly emitter?: SSEEventEmitter,
    private readonly conversationLogger?: ConversationLogger,
  ) {}

  /**
   * Get the Claude CLI session ID captured from the `init` event.
   * Returns undefined if no session ID has been received yet.
   */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * Get the implement partial result parsed from the SPECKIT_IMPLEMENT_PARTIAL sentinel.
   * Returns undefined if no sentinel was seen in the output.
   */
  get implementResult(): ImplementPartialResult | undefined {
    return this._implementResult;
  }

  /**
   * Process a chunk of stdout data from Claude CLI.
   * Parses newline-delimited JSON lines.
   */
  processChunk(chunk: string): void {
    this.lineBuffer += chunk;

    const lines = this.lineBuffer.split('\n');

    // The last element is either an empty string (if chunk ended with \n)
    // or an incomplete line that we keep in the buffer.
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      this.parseLine(trimmed);
    }
  }

  /**
   * Flush any remaining data in the line buffer.
   */
  flush(): void {
    const remaining = this.lineBuffer.trim();
    this.lineBuffer = '';

    if (remaining.length === 0) {
      return;
    }

    this.parseLine(remaining);
  }

  /**
   * Get all captured output chunks.
   */
  getOutput(): OutputChunk[] {
    return [...this.buffer];
  }

  /**
   * Clear the output buffer.
   */
  clear(): void {
    this.buffer = [];
  }

  /** Prefix used by the implement operation to signal a partial result. */
  private static readonly SENTINEL_PREFIX = 'SPECKIT_IMPLEMENT_PARTIAL: ';

  /**
   * Parse a single line of JSON and push the resulting OutputChunk.
   */
  private parseLine(line: string): void {
    // Check for the implement partial sentinel before attempting JSON parse.
    // The sentinel is embedded in text chunks output by the Claude CLI.
    if (line.startsWith(OutputCapture.SENTINEL_PREFIX)) {
      const jsonPart = line.slice(OutputCapture.SENTINEL_PREFIX.length);
      try {
        const parsed = JSON.parse(jsonPart) as ImplementPartialResult;
        this._implementResult = parsed;
        this.logger.debug({ implementResult: this._implementResult }, 'Parsed SPECKIT_IMPLEMENT_PARTIAL sentinel');
      } catch {
        this.logger.warn({ line }, 'Malformed SPECKIT_IMPLEMENT_PARTIAL sentinel — ignoring');
      }
      // Still push as a text chunk so the full output is preserved
      const chunk: OutputChunk = {
        type: 'text',
        data: { text: line },
        timestamp: new Date().toISOString(),
      };
      this.buffer.push(chunk);
      return;
    }

    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.logger.debug({ line }, 'Non-JSON line from Claude CLI, treating as text');
      const chunk: OutputChunk = {
        type: 'text',
        data: { text: line },
        timestamp: new Date().toISOString(),
      };
      this.buffer.push(chunk);
      return;
    }

    const rawType = typeof parsed.type === 'string' ? parsed.type : 'text';
    const type: OutputChunk['type'] = KNOWN_TYPES.has(rawType as OutputChunk['type'])
      ? (rawType as OutputChunk['type'])
      : 'text';

    // Extract metadata from tool_result chunks (e.g., filePath)
    let metadata: Record<string, string> | undefined;
    if (type === 'tool_result' && typeof parsed.filePath === 'string') {
      metadata = { filePath: parsed.filePath };
    }

    const chunk: OutputChunk = {
      type,
      data: parsed,
      ...(metadata ? { metadata } : {}),
      timestamp: new Date().toISOString(),
    };

    // Extract session_id from init events for conversation resume support
    if (type === 'init' && typeof parsed.session_id === 'string') {
      this._sessionId = parsed.session_id;
      this.logger.debug({ sessionId: this._sessionId }, 'Captured Claude CLI session ID');
    }

    this.buffer.push(chunk);
    this.conversationLogger?.logEvent(chunk);
    this.emitSSEEvent(chunk);
  }

  /**
   * Emit SSE events based on the chunk type.
   */
  private emitSSEEvent(chunk: OutputChunk): void {
    if (!this.emitter) {
      return;
    }

    switch (chunk.type) {
      case 'init':
        this.emitter({
          type: 'step:started',
          workflowId: this.workflowId,
          data: { timestamp: chunk.timestamp, output: chunk.data },
        });
        break;

      case 'complete':
        this.emitter({
          type: 'step:completed',
          workflowId: this.workflowId,
          data: { timestamp: chunk.timestamp, output: chunk.data },
        });
        break;

      case 'error':
        this.logger.warn(
          { workflowId: this.workflowId, error: chunk.data },
          'Error chunk received from Claude CLI',
        );
        break;

      default:
        // No SSE event for other chunk types
        break;
    }
  }
}
