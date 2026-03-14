import type { ConversationOutputEvent, ConversationEventType } from './types.js';

/**
 * Maps Claude CLI stream-json event types to conversation event types.
 */
const CLI_EVENT_MAP: Record<string, ConversationEventType> = {
  init: 'output',
  text: 'output',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  complete: 'complete',
  error: 'error',
};

/**
 * Parses newline-delimited JSON from Claude CLI stdout and emits
 * ConversationOutputEvent instances via a callback.
 *
 * Handles partial lines (buffering until a newline is received)
 * and malformed JSON (logs warning and skips).
 */
export class ConversationOutputParser {
  private buffer = '';
  private readonly onEvent: (event: ConversationOutputEvent) => void;
  private readonly onSessionId: (sessionId: string) => void;
  private readonly onError: (error: string) => void;

  constructor(options: {
    onEvent: (event: ConversationOutputEvent) => void;
    onSessionId: (sessionId: string) => void;
    onError?: (error: string) => void;
  }) {
    this.onEvent = options.onEvent;
    this.onSessionId = options.onSessionId;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Process a chunk of data from stdout. May contain partial lines,
   * complete lines, or multiple lines.
   */
  processChunk(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) continue;
      this.parseLine(line);
    }
  }

  /**
   * Flush any remaining buffer content (called when the process exits).
   */
  flush(): void {
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      this.parseLine(remaining);
    }
    this.buffer = '';
  }

  private parseLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onError(`Malformed JSON from CLI: ${line.slice(0, 200)}`);
      return;
    }

    const cliType = parsed.type as string | undefined;
    if (!cliType) {
      this.onError(`CLI event missing type field: ${line.slice(0, 200)}`);
      return;
    }

    // Capture session ID from init event
    if (cliType === 'init' && typeof parsed.session_id === 'string') {
      this.onSessionId(parsed.session_id);
    }

    const eventType = CLI_EVENT_MAP[cliType];
    if (!eventType) {
      // Unknown event type — skip silently
      return;
    }

    // Build the payload based on event type
    let payload: unknown;
    switch (cliType) {
      case 'init':
        payload = {
          sessionId: parsed.session_id,
          model: parsed.model,
        };
        break;
      case 'text':
        payload = { text: parsed.text };
        break;
      case 'tool_use':
        payload = {
          toolName: parsed.tool_name,
          callId: parsed.call_id,
          input: parsed.input,
        };
        break;
      case 'tool_result':
        payload = {
          toolName: parsed.tool_name,
          callId: parsed.call_id,
          output: parsed.output,
          filePath: parsed.filePath,
        };
        break;
      case 'complete':
        payload = {
          tokensIn: parsed.tokens_in,
          tokensOut: parsed.tokens_out,
        };
        break;
      case 'error':
        payload = { message: parsed.message };
        break;
      default:
        payload = parsed;
    }

    this.onEvent({
      event: eventType,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
