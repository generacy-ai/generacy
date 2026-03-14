import { describe, it, expect, vi } from 'vitest';
import { ConversationOutputParser } from '../output-parser.js';
import type { ConversationOutputEvent } from '../types.js';

function createParser() {
  const events: ConversationOutputEvent[] = [];
  const sessionIds: string[] = [];
  const errors: string[] = [];

  const parser = new ConversationOutputParser({
    onEvent: (event) => events.push(event),
    onSessionId: (id) => sessionIds.push(id),
    onError: (err) => errors.push(err),
  });

  return { parser, events, sessionIds, errors };
}

describe('ConversationOutputParser', () => {
  describe('init event', () => {
    it('maps init to output event and captures sessionId', () => {
      const { parser, events, sessionIds } = createParser();

      parser.processChunk('{"type":"init","session_id":"ses-123","model":"claude-sonnet-4-6"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
      expect(events[0].payload).toEqual({
        sessionId: 'ses-123',
        model: 'claude-sonnet-4-6',
      });
      expect(sessionIds).toEqual(['ses-123']);
    });
  });

  describe('text event', () => {
    it('maps text to output event', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"text","text":"Hello!"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
      expect(events[0].payload).toEqual({ text: 'Hello!' });
    });
  });

  describe('tool_use event', () => {
    it('maps tool_use with correct fields', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"tool_use","tool_name":"Read","call_id":"call_1","input":{"path":"/foo"}}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('tool_use');
      expect(events[0].payload).toEqual({
        toolName: 'Read',
        callId: 'call_1',
        input: { path: '/foo' },
      });
    });
  });

  describe('tool_result event', () => {
    it('maps tool_result with correct fields', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"tool_result","tool_name":"Read","call_id":"call_1","output":"file contents","filePath":"/foo"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('tool_result');
      expect(events[0].payload).toEqual({
        toolName: 'Read',
        callId: 'call_1',
        output: 'file contents',
        filePath: '/foo',
      });
    });
  });

  describe('complete event', () => {
    it('maps complete with token counts', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"complete","tokens_in":1234,"tokens_out":567}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('complete');
      expect(events[0].payload).toEqual({
        tokensIn: 1234,
        tokensOut: 567,
      });
    });
  });

  describe('error event', () => {
    it('maps error with message', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"error","message":"Something went wrong"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('error');
      expect(events[0].payload).toEqual({ message: 'Something went wrong' });
    });
  });

  describe('malformed JSON handling', () => {
    it('reports error and continues parsing', () => {
      const { parser, events, errors } = createParser();

      parser.processChunk('not json\n{"type":"text","text":"after error"}\n');

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Malformed JSON');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
    });
  });

  describe('partial line buffering', () => {
    it('buffers partial lines until newline is received', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"tex');
      expect(events).toHaveLength(0);

      parser.processChunk('t","text":"Hello!"}\n');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ text: 'Hello!' });
    });
  });

  describe('multiple lines in one chunk', () => {
    it('parses all complete lines', () => {
      const { parser, events } = createParser();

      parser.processChunk(
        '{"type":"init","session_id":"s1","model":"m1"}\n' +
        '{"type":"text","text":"Hello"}\n' +
        '{"type":"complete","tokens_in":100,"tokens_out":50}\n'
      );

      expect(events).toHaveLength(3);
      expect(events[0].event).toBe('output');
      expect(events[1].event).toBe('output');
      expect(events[2].event).toBe('complete');
    });
  });

  describe('flush', () => {
    it('processes remaining buffer content', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"text","text":"last"}');
      expect(events).toHaveLength(0);

      parser.flush();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ text: 'last' });
    });

    it('handles empty buffer on flush', () => {
      const { parser, events } = createParser();
      parser.flush();
      expect(events).toHaveLength(0);
    });
  });

  describe('unknown event types', () => {
    it('skips unknown CLI event types silently', () => {
      const { parser, events, errors } = createParser();

      parser.processChunk('{"type":"unknown_event","data":"foo"}\n');

      expect(events).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  describe('missing type field', () => {
    it('reports error for events without type', () => {
      const { parser, events, errors } = createParser();

      parser.processChunk('{"data":"no type"}\n');

      expect(events).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing type field');
    });
  });

  describe('timestamp', () => {
    it('includes ISO timestamp in events', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"text","text":"test"}\n');

      expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
