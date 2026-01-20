/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Output parser for Claude Code JSON Lines format.
 */

import type {
  OutputChunk,
  OutputChunkType,
  OutputMetadata,
  QuestionPayload,
  UrgencyLevel,
} from '../types.js';
import type {
  RawClaudeOutput,
  ParserState,
} from './types.js';
import {
  OUTPUT_TYPE_MAP,
  parseUrgency,
  createInitialParserState,
} from './types.js';

/**
 * Parser for Claude Code JSON Lines output.
 */
export class OutputParser {
  private state: ParserState;

  constructor() {
    this.state = createInitialParserState();
  }

  /**
   * Reset parser state.
   */
  reset(): void {
    this.state = createInitialParserState();
  }

  /**
   * Parse a chunk of data (may contain multiple lines or partial lines).
   */
  parseChunk(data: string): OutputChunk[] {
    const chunks: OutputChunk[] = [];

    // Add to buffer
    this.state.buffer += data;

    // Process complete lines
    const lines = this.state.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.state.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const chunk = this.parseLine(trimmed);
      if (chunk) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * Flush any remaining buffered content.
   */
  flush(): OutputChunk[] {
    const chunks: OutputChunk[] = [];

    if (this.state.buffer.trim()) {
      const chunk = this.parseLine(this.state.buffer.trim());
      if (chunk) {
        chunks.push(chunk);
      }
      this.state.buffer = '';
    }

    return chunks;
  }

  /**
   * Parse a single line of JSON output.
   */
  parseLine(line: string): OutputChunk | null {
    try {
      const raw = JSON.parse(line) as RawClaudeOutput;
      return this.parseRawOutput(raw);
    } catch {
      // Not valid JSON - treat as raw stdout
      return this.createStdoutChunk(line);
    }
  }

  /**
   * Parse a raw Claude output object into an OutputChunk.
   */
  parseRawOutput(raw: RawClaudeOutput): OutputChunk | null {
    const timestamp = raw.timestamp ? new Date(raw.timestamp) : new Date();

    // Check for question first (special handling)
    if (this.isQuestion(raw)) {
      return this.createQuestionChunk(raw, timestamp);
    }

    // Map type to OutputChunkType
    const type = this.mapType(raw.type);

    // Build metadata
    const metadata = this.buildMetadata(raw, type);

    // Build data based on type
    const data = this.buildData(raw, type);

    return {
      type,
      timestamp,
      data,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  /**
   * Create a stdout chunk from raw text.
   */
  createStdoutChunk(content: string): OutputChunk {
    return {
      type: 'stdout',
      timestamp: new Date(),
      data: { content },
    };
  }

  /**
   * Create a stderr chunk from raw text.
   */
  createStderrChunk(content: string): OutputChunk {
    return {
      type: 'stderr',
      timestamp: new Date(),
      data: { content },
    };
  }

  /**
   * Create an error chunk.
   */
  createErrorChunk(
    message: string,
    code?: string,
    isTransient?: boolean
  ): OutputChunk {
    return {
      type: 'error',
      timestamp: new Date(),
      data: {
        message,
        code: code ?? 'UNKNOWN',
        isTransient: isTransient ?? false,
      },
    };
  }

  /**
   * Create a completion chunk.
   */
  createCompleteChunk(
    exitCode: number,
    summary?: string,
    filesModified?: string[]
  ): OutputChunk {
    return {
      type: 'complete',
      timestamp: new Date(),
      data: {
        exitCode,
        summary,
        filesModified,
      },
      metadata: {
        isSuccess: exitCode === 0,
      },
    };
  }

  /**
   * Detect if a raw output is a question requiring human input.
   */
  isQuestion(raw: RawClaudeOutput): boolean {
    // Explicit question flag
    if (raw.is_question === true) {
      return true;
    }

    // Check for question in content
    if (raw.type === 'assistant' && typeof raw.content === 'string') {
      return this.detectQuestionInContent(raw.content);
    }

    // Check for question field
    if (raw.question) {
      return true;
    }

    return false;
  }

  /**
   * Detect question patterns in content.
   */
  detectQuestionInContent(content: string): boolean {
    // Patterns that indicate a question requiring human input
    const questionPatterns = [
      /\?\s*$/m, // Ends with question mark
      /please\s+(confirm|choose|select|decide)/i,
      /which\s+(option|approach|method)/i,
      /should\s+I/i,
      /do\s+you\s+want/i,
      /would\s+you\s+like/i,
      /awaiting\s+(your\s+)?(input|response|decision)/i,
      /\[waiting\s+for\s+(input|response)\]/i,
    ];

    return questionPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * Detect urgency level from content.
   */
  detectUrgency(raw: RawClaudeOutput): UrgencyLevel {
    // Explicit urgency
    if (raw.urgency) {
      return parseUrgency(raw.urgency);
    }

    // Detect from content
    const content = typeof raw.content === 'string' ? raw.content : '';

    if (/urgent|immediate|critical|blocking/i.test(content)) {
      return 'blocking_now';
    }

    if (/soon|shortly|when\s+possible/i.test(content)) {
      return 'blocking_soon';
    }

    return 'when_available';
  }

  /**
   * Create a question chunk.
   */
  private createQuestionChunk(raw: RawClaudeOutput, timestamp: Date): OutputChunk {
    const content = typeof raw.content === 'string' ? raw.content : '';
    const question = raw.question ?? this.extractQuestion(content);
    const urgency = this.detectUrgency(raw);

    const payload: QuestionPayload = {
      question,
      urgency,
      choices: raw.choices,
      context: content !== question ? content : undefined,
      askedAt: timestamp,
    };

    return {
      type: 'question',
      timestamp,
      data: payload,
      metadata: {
        urgency,
      },
    };
  }

  /**
   * Extract the question text from content.
   */
  private extractQuestion(content: string): string {
    // Find sentences ending with ?
    const sentences = content.split(/(?<=[.!?])\s+/);
    const questions = sentences.filter((s) => s.trim().endsWith('?'));

    if (questions.length > 0) {
      return questions.join(' ');
    }

    // Return first line if no explicit question
    const firstLine = content.split('\n')[0];
    return firstLine ?? content;
  }

  /**
   * Map raw type to OutputChunkType.
   */
  private mapType(rawType: string): OutputChunkType {
    return OUTPUT_TYPE_MAP[rawType as keyof typeof OUTPUT_TYPE_MAP] ?? 'stdout';
  }

  /**
   * Build metadata for a chunk.
   */
  private buildMetadata(
    raw: RawClaudeOutput,
    type: OutputChunkType
  ): OutputMetadata {
    const metadata: OutputMetadata = {};

    if (raw.tool) {
      metadata.toolName = raw.tool;
    }

    if (raw.file) {
      metadata.filePath = raw.file;
    }

    if (type === 'tool_result' && raw.result !== undefined) {
      metadata.isSuccess = !this.isErrorResult(raw.result);
    }

    if (type === 'complete') {
      metadata.isSuccess = raw.exit_code === 0;
    }

    return metadata;
  }

  /**
   * Build data payload for a chunk.
   */
  private buildData(raw: RawClaudeOutput, type: OutputChunkType): unknown {
    switch (type) {
      case 'stdout':
      case 'stderr':
        return { content: this.extractContent(raw) };

      case 'tool_call':
        return {
          tool: raw.tool,
          input: raw.input ?? raw.content,
        };

      case 'tool_result':
        return {
          tool: raw.tool,
          result: raw.result ?? raw.content,
          success: !this.isErrorResult(raw.result),
        };

      case 'error':
        return {
          message: raw.error ?? this.extractContent(raw),
          code: 'UNKNOWN',
          isTransient: false,
        };

      case 'complete':
        return {
          exitCode: raw.exit_code ?? 0,
          summary: typeof raw.content === 'string' ? raw.content : undefined,
        };

      default:
        return raw.content;
    }
  }

  /**
   * Extract content from raw output.
   */
  private extractContent(raw: RawClaudeOutput): string {
    if (typeof raw.content === 'string') {
      return raw.content;
    }
    if (raw.content !== undefined) {
      return JSON.stringify(raw.content);
    }
    return '';
  }

  /**
   * Check if a result indicates an error.
   */
  private isErrorResult(result: unknown): boolean {
    if (result === null || result === undefined) {
      return false;
    }

    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      return obj.error !== undefined || obj.success === false;
    }

    if (typeof result === 'string') {
      return /error|failed|exception/i.test(result);
    }

    return false;
  }
}
