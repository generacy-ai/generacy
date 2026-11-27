import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputCapture, type SSEEventEmitter } from '../output-capture.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: vi.fn(),
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

/** Build an assistant stream-json envelope line carrying the given text blocks. */
function assistantEnvelope(...texts: string[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: texts.map(text => ({ type: 'text', text })),
    },
  });
}

/** Build a terminal `result` stream-json envelope line. */
function resultEnvelope(result: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', result });
}

const PARTIAL = 'SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":10,"tasks_remaining":44,"tasks_total":54}';
const BLOCKED = 'SPECKIT_IMPLEMENT_BLOCKED: {"on":["generacy-ai/generacy#1198","#1199"]}';

describe('OutputCapture — sentinels embedded in stream-json envelopes', () => {
  let capture: OutputCapture;
  let emitter: SSEEventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    emitter = vi.fn();
    capture = new OutputCapture('wf-123', mockLogger, emitter);
  });

  it('FR-001: PARTIAL as the sole line of an assistant text block populates implementResult', () => {
    capture.processChunk(assistantEnvelope(PARTIAL) + '\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.tasks_completed).toBe(10);
    expect(result!.tasks_remaining).toBe(44);
    expect(result!.tasks_total).toBe(54);
  });

  it('FR-001: PARTIAL on its own line at the end of a multi-line text block is found', () => {
    const block = `I have completed the increment. Summary of work:\n- did a thing\n- did another\n${PARTIAL}`;
    capture.processChunk(assistantEnvelope(block) + '\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.tasks_remaining).toBe(44);
  });

  it('FR-002: PARTIAL inside a result event result string is found', () => {
    capture.processChunk(resultEnvelope(`Done for now.\n\n${PARTIAL}`) + '\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.tasks_remaining).toBe(44);
  });

  it('US1/AC3: BLOCKED inside an assistant text block populates blocked_on', () => {
    capture.processChunk(assistantEnvelope(`Waiting on deps.\n${BLOCKED}`) + '\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.blocked_on).toEqual(['generacy-ai/generacy#1198', '#1199']);
  });

  it('FR-004: last-wins across multiple envelope sentinels', () => {
    capture.processChunk(assistantEnvelope('SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":1,"tasks_remaining":9,"tasks_total":10}') + '\n');
    capture.processChunk(resultEnvelope('SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":3,"tasks_remaining":7,"tasks_total":10}') + '\n');
    const result = capture.implementResult;
    expect(result!.tasks_completed).toBe(3);
    expect(result!.tasks_remaining).toBe(7);
  });

  it('FR-004: BLOCKED-then-PARTIAL inside envelopes preserves blocked_on (#1211 Q2=A)', () => {
    capture.processChunk(assistantEnvelope(BLOCKED) + '\n');
    capture.processChunk(resultEnvelope('SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":3,"tasks_remaining":7,"tasks_total":10}') + '\n');
    const result = capture.implementResult;
    expect(result!.partial).toBe(true);
    expect(result!.tasks_completed).toBe(3);
    expect(result!.blocked_on).toEqual(['generacy-ai/generacy#1198', '#1199']);
  });

  it('FR-006: identical PARTIAL in both an assistant block and the result string is idempotent', () => {
    // Single envelope carrying the sentinel in both an assistant block and... emulate
    // the observed shape: assistant envelope then a result envelope with the same payload.
    capture.processChunk(assistantEnvelope(`Final summary.\n${PARTIAL}`) + '\n');
    capture.processChunk(resultEnvelope(`Final summary.\n${PARTIAL}`) + '\n');
    const result = capture.implementResult;
    expect(result).toEqual({
      partial: true,
      tasks_completed: 10,
      tasks_remaining: 44,
      tasks_total: 54,
    });
  });

  it('FR-005: malformed sentinel JSON inside an envelope warns and leaves implementResult undefined', () => {
    capture.processChunk(assistantEnvelope('SPECKIT_IMPLEMENT_PARTIAL: {not valid json}') + '\n');
    expect(capture.implementResult).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ line: 'SPECKIT_IMPLEMENT_PARTIAL: {not valid json}' }),
      expect.stringContaining('Malformed'),
    );
  });

  describe('robustness: variant envelope shapes neither throw nor set implementResult', () => {
    it('message is not an object', () => {
      expect(() => capture.processChunk(JSON.stringify({ type: 'assistant', message: 'nope' }) + '\n')).not.toThrow();
      expect(capture.implementResult).toBeUndefined();
    });

    it('content is not an array', () => {
      expect(() => capture.processChunk(JSON.stringify({ type: 'assistant', message: { content: 'nope' } }) + '\n')).not.toThrow();
      expect(capture.implementResult).toBeUndefined();
    });

    it('blocks without text', () => {
      expect(() =>
        capture.processChunk(
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } }) + '\n',
        ),
      ).not.toThrow();
      expect(capture.implementResult).toBeUndefined();
    });

    it('non-string result', () => {
      expect(() => capture.processChunk(JSON.stringify({ type: 'result', result: { nested: true } }) + '\n')).not.toThrow();
      expect(capture.implementResult).toBeUndefined();
    });

    it('null message / null content / null blocks', () => {
      expect(() => capture.processChunk(JSON.stringify({ type: 'assistant', message: null }) + '\n')).not.toThrow();
      expect(() =>
        capture.processChunk(JSON.stringify({ type: 'assistant', message: { content: null } }) + '\n'),
      ).not.toThrow();
      expect(() =>
        capture.processChunk(JSON.stringify({ type: 'assistant', message: { content: [null] } }) + '\n'),
      ).not.toThrow();
      expect(capture.implementResult).toBeUndefined();
    });
  });

  it('getOutput(): envelope scan adds no extra chunks and the envelope chunk is preserved', () => {
    capture.processChunk(assistantEnvelope(`Final summary.\n${PARTIAL}`) + '\n');
    const output = capture.getOutput();
    expect(output).toHaveLength(1);
    expect(output[0]!.type).toBe('text');
    // The envelope itself is pushed (normalized to a text chunk), not a synthesized
    // sentinel text chunk.
    expect(output[0]!.data).toHaveProperty('message');
  });

  it('SC-001: replays a captured-transcript-shaped fixture and finds the PARTIAL', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
      assistantEnvelope('Let me start on the tasks.'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
      assistantEnvelope(`I have completed 10 of 54 tasks this session.\n\n${PARTIAL}`),
      resultEnvelope(`I have completed 10 of 54 tasks this session.\n\n${PARTIAL}`),
    ];
    for (const line of lines) {
      capture.processChunk(line + '\n');
    }
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
    expect(result!.tasks_completed).toBe(10);
    expect(result!.tasks_remaining).toBe(44);
    expect(result!.tasks_total).toBe(54);
  });
});
