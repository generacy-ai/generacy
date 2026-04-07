import type { ConversationOutputEvent, ConversationEventType } from './types.js';

/**
 * Parses newline-delimited JSON from Claude CLI stdout (stream-json --verbose)
 * and emits ConversationOutputEvent instances via a callback.
 *
 * Claude CLI stream-json format uses these top-level types:
 * - system (subtype: init)  — session initialized
 * - assistant               — message with content blocks (text, tool_use)
 * - tool_result             — tool execution result (only in interactive mode)
 * - result (subtype: success/error) — turn completed
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

    const timestamp = new Date().toISOString();

    switch (cliType) {
      case 'system': {
        // Init event: {"type":"system","subtype":"init","session_id":"...","model":"..."}
        if (parsed.subtype === 'init' && typeof parsed.session_id === 'string') {
          this.onSessionId(parsed.session_id);
          this.emit('output', {
            sessionId: parsed.session_id,
            model: parsed.model,
          }, timestamp);
        }
        break;
      }

      case 'assistant': {
        // Assistant message: {"type":"assistant","message":{"content":[...],...},...}
        const message = parsed.message as Record<string, unknown> | undefined;
        if (!message) break;

        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            this.emit('output', { text: block.text }, timestamp);
          } else if (block.type === 'tool_use') {
            this.emit('tool_use', {
              toolName: block.name,
              callId: block.id,
              input: block.input,
            }, timestamp);
          }
        }
        break;
      }

      case 'tool_result': {
        // Tool result: {"type":"tool_result","tool_use_id":"...","content":"..."}
        this.emit('tool_result', {
          callId: parsed.tool_use_id ?? parsed.call_id,
          output: parsed.content ?? parsed.output,
        }, timestamp);
        break;
      }

      case 'result': {
        // Turn completed: {"type":"result","subtype":"success","usage":{...},...}
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (parsed.is_error || parsed.subtype === 'error') {
          this.emit('error', {
            message: (parsed.error as string) ?? (parsed.result as string) ?? 'Unknown error',
          }, timestamp);
        } else {
          this.emit('complete', {
            tokensIn: usage?.input_tokens ?? 0,
            tokensOut: usage?.output_tokens ?? 0,
          }, timestamp);
        }
        break;
      }

      // Skip rate_limit_event and unknown types silently
      default:
        break;
    }
  }

  private emit(event: ConversationEventType, payload: unknown, timestamp: string): void {
    this.onEvent({ event, payload, timestamp });
  }
}
