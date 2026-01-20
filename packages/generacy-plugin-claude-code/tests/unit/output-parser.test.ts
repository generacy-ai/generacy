/**
 * Unit tests for OutputParser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutputParser } from '../../src/streaming/output-parser.js';

describe('OutputParser', () => {
  let parser: OutputParser;

  beforeEach(() => {
    parser = new OutputParser();
  });

  describe('parseLine', () => {
    it('should parse valid JSON stdout message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Hello, world!',
        timestamp: '2024-01-01T00:00:00Z',
      });

      const chunk = parser.parseLine(line);

      expect(chunk).not.toBeNull();
      expect(chunk!.type).toBe('stdout');
      expect(chunk!.data).toEqual({ content: 'Hello, world!' });
    });

    it('should parse tool_use as tool_call', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool: 'Read',
        input: { file_path: '/test.txt' },
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('tool_call');
      expect(chunk!.data).toEqual({
        tool: 'Read',
        input: { file_path: '/test.txt' },
      });
      expect(chunk!.metadata?.toolName).toBe('Read');
    });

    it('should parse tool_result', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool: 'Read',
        result: { content: 'file contents' },
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('tool_result');
      expect(chunk!.metadata?.toolName).toBe('Read');
      expect(chunk!.metadata?.isSuccess).toBe(true);
    });

    it('should parse error messages', () => {
      const line = JSON.stringify({
        type: 'error',
        error: 'Something went wrong',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('error');
      expect(chunk!.data).toEqual({
        message: 'Something went wrong',
        code: 'UNKNOWN',
        isTransient: false,
      });
    });

    it('should parse completion result', () => {
      const line = JSON.stringify({
        type: 'result',
        exit_code: 0,
        content: 'Task completed successfully',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('complete');
      expect(chunk!.data).toEqual({
        exitCode: 0,
        summary: 'Task completed successfully',
      });
      expect(chunk!.metadata?.isSuccess).toBe(true);
    });

    it('should handle non-JSON lines as stdout', () => {
      const line = 'This is plain text output';

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('stdout');
      expect(chunk!.data).toEqual({ content: line });
    });

    it('should include file path in metadata', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool: 'Read',
        file: '/path/to/file.txt',
        result: { content: 'contents' },
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.metadata?.filePath).toBe('/path/to/file.txt');
    });
  });

  describe('parseChunk', () => {
    it('should parse multiple lines', () => {
      const data = [
        JSON.stringify({ type: 'assistant', content: 'Line 1' }),
        JSON.stringify({ type: 'assistant', content: 'Line 2' }),
      ].join('\n') + '\n';

      const chunks = parser.parseChunk(data);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.data).toEqual({ content: 'Line 1' });
      expect(chunks[1]!.data).toEqual({ content: 'Line 2' });
    });

    it('should handle partial lines', () => {
      // First chunk with incomplete line
      const chunks1 = parser.parseChunk('{"type":"assis');

      expect(chunks1).toHaveLength(0);

      // Complete the line
      const chunks2 = parser.parseChunk('tant","content":"Hello"}\n');

      expect(chunks2).toHaveLength(1);
      expect(chunks2[0]!.data).toEqual({ content: 'Hello' });
    });

    it('should skip empty lines', () => {
      const data = '\n\n' + JSON.stringify({ type: 'assistant', content: 'Hello' }) + '\n\n';

      const chunks = parser.parseChunk(data);

      expect(chunks).toHaveLength(1);
    });
  });

  describe('flush', () => {
    it('should flush buffered content', () => {
      parser.parseChunk(JSON.stringify({ type: 'assistant', content: 'Buffered' }));

      const chunks = parser.flush();

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.data).toEqual({ content: 'Buffered' });
    });

    it('should return empty array if no buffered content', () => {
      const chunks = parser.flush();

      expect(chunks).toHaveLength(0);
    });
  });

  describe('question detection', () => {
    it('should detect explicit question flag', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Do you want to proceed?',
        is_question: true,
        urgency: 'blocking_now',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('question');
      expect(chunk!.data).toMatchObject({
        question: expect.any(String),
        urgency: 'blocking_now',
      });
    });

    it('should detect question in content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Which option would you like to choose?',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('question');
    });

    it('should detect "should I" pattern', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Should I create the file?',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('question');
    });

    it('should detect "do you want" pattern', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Do you want me to continue?',
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.type).toBe('question');
    });

    it('should include choices in question payload', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'Select an option',
        is_question: true,
        choices: ['Option A', 'Option B', 'Option C'],
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.data).toMatchObject({
        choices: ['Option A', 'Option B', 'Option C'],
      });
    });

    it('should detect urgency from content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        content: 'URGENT: Please respond immediately?',
        is_question: true,
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.data).toMatchObject({
        urgency: 'blocking_now',
      });
    });
  });

  describe('error detection', () => {
    it('should detect error in tool result', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool: 'Read',
        result: { error: 'File not found' },
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.metadata?.isSuccess).toBe(false);
    });

    it('should detect success: false in result', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool: 'Write',
        result: { success: false, message: 'Permission denied' },
      });

      const chunk = parser.parseLine(line);

      expect(chunk!.metadata?.isSuccess).toBe(false);
    });
  });

  describe('helper methods', () => {
    it('should create stdout chunk', () => {
      const chunk = parser.createStdoutChunk('Hello');

      expect(chunk.type).toBe('stdout');
      expect(chunk.data).toEqual({ content: 'Hello' });
    });

    it('should create stderr chunk', () => {
      const chunk = parser.createStderrChunk('Error message');

      expect(chunk.type).toBe('stderr');
      expect(chunk.data).toEqual({ content: 'Error message' });
    });

    it('should create error chunk', () => {
      const chunk = parser.createErrorChunk('Something failed', 'API_TIMEOUT', true);

      expect(chunk.type).toBe('error');
      expect(chunk.data).toEqual({
        message: 'Something failed',
        code: 'API_TIMEOUT',
        isTransient: true,
      });
    });

    it('should create complete chunk', () => {
      const chunk = parser.createCompleteChunk(0, 'Done', ['file1.ts', 'file2.ts']);

      expect(chunk.type).toBe('complete');
      expect(chunk.data).toEqual({
        exitCode: 0,
        summary: 'Done',
        filesModified: ['file1.ts', 'file2.ts'],
      });
      expect(chunk.metadata?.isSuccess).toBe(true);
    });
  });

  describe('reset', () => {
    it('should clear parser state', () => {
      // Add some buffered content
      parser.parseChunk('{"type":"assistant"');

      // Reset
      parser.reset();

      // Flush should return nothing
      const chunks = parser.flush();
      expect(chunks).toHaveLength(0);
    });
  });
});
