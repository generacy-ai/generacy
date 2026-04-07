import { describe, it, expect } from 'vitest';
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
  describe('system init event', () => {
    it('maps system init to output event and captures sessionId', () => {
      const { parser, events, sessionIds } = createParser();

      parser.processChunk('{"type":"system","subtype":"init","session_id":"ses-123","model":"claude-sonnet-4-6"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
      expect(events[0].payload).toEqual({
        sessionId: 'ses-123',
        model: 'claude-sonnet-4-6',
      });
      expect(sessionIds).toEqual(['ses-123']);
    });

    it('ignores system events without init subtype', () => {
      const { parser, events, sessionIds } = createParser();

      parser.processChunk('{"type":"system","subtype":"other"}\n');

      expect(events).toHaveLength(0);
      expect(sessionIds).toHaveLength(0);
    });
  });

  describe('assistant event', () => {
    it('maps assistant text content to output event', () => {
      const { parser, events } = createParser();

      parser.processChunk(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello!' }],
        },
      }) + '\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
      expect(events[0].payload).toEqual({ text: 'Hello!' });
    });

    it('maps assistant tool_use content to tool_use event', () => {
      const { parser, events } = createParser();

      parser.processChunk(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/foo' } }],
        },
      }) + '\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('tool_use');
      expect(events[0].payload).toEqual({
        toolName: 'Read',
        callId: 'call_1',
        input: { path: '/foo' },
      });
    });

    it('emits multiple events for mixed content blocks', () => {
      const { parser, events } = createParser();

      parser.processChunk(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read that.' },
            { type: 'tool_use', id: 'call_2', name: 'Read', input: { path: '/bar' } },
          ],
        },
      }) + '\n');

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe('output');
      expect(events[1].event).toBe('tool_use');
    });

    it('skips assistant events without message', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"assistant"}\n');

      expect(events).toHaveLength(0);
    });
  });

  describe('tool_result event', () => {
    it('maps tool_result with tool_use_id and content', () => {
      const { parser, events } = createParser();

      parser.processChunk('{"type":"tool_result","tool_use_id":"call_1","content":"file contents"}\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('tool_result');
      expect(events[0].payload).toEqual({
        callId: 'call_1',
        output: 'file contents',
      });
    });
  });

  describe('result event', () => {
    it('maps successful result to complete event with usage', () => {
      const { parser, events } = createParser();

      parser.processChunk(JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1234, output_tokens: 567 },
      }) + '\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('complete');
      expect(events[0].payload).toEqual({
        tokensIn: 1234,
        tokensOut: 567,
      });
    });

    it('maps error result to error event', () => {
      const { parser, events } = createParser();

      parser.processChunk(JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Something went wrong',
      }) + '\n');

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('error');
      expect(events[0].payload).toEqual({ message: 'Something went wrong' });
    });
  });

  describe('malformed JSON handling', () => {
    it('reports error and continues parsing', () => {
      const { parser, events, errors } = createParser();

      parser.processChunk('not json\n' + JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'after error' }] },
      }) + '\n');

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Malformed JSON');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('output');
    });
  });

  describe('partial line buffering', () => {
    it('buffers partial lines until newline is received', () => {
      const { parser, events } = createParser();
      const msg = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello!' }] },
      });

      parser.processChunk(msg.slice(0, 15));
      expect(events).toHaveLength(0);

      parser.processChunk(msg.slice(15) + '\n');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ text: 'Hello!' });
    });
  });

  describe('multiple lines in one chunk', () => {
    it('parses all complete lines', () => {
      const { parser, events } = createParser();

      parser.processChunk(
        '{"type":"system","subtype":"init","session_id":"s1","model":"m1"}\n' +
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }) + '\n' +
        JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50 } }) + '\n'
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

      parser.processChunk(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'last' }] },
      }));
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

      parser.processChunk('{"type":"rate_limit_event","data":"foo"}\n');

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

      parser.processChunk(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'test' }] },
      }) + '\n');

      expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
