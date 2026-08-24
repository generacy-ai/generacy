import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { synthesizeOutputTail } from '../output-tail-synthesis.js';
import type { OutputChunk } from '../types.js';

const MARKER_PREFIX = '… truncated (kept last ';

function textChunk(text: unknown): OutputChunk {
  return {
    type: 'text',
    data: { text },
    timestamp: '2026-07-09T00:00:00.000Z',
  };
}

function nonTextChunk(type: Exclude<OutputChunk['type'], 'text'>): OutputChunk {
  return {
    type,
    data: {},
    timestamp: '2026-07-09T00:00:00.000Z',
  };
}

describe('synthesizeOutputTail', () => {
  it('returns the empty literal for an empty chunks array', () => {
    expect(synthesizeOutputTail([])).toBe('(no output on either stream)');
  });

  it('returns a single text chunk unchanged when under the byte cap', () => {
    const result = synthesizeOutputTail([textChunk('single line of output')]);
    expect(result).toBe('single line of output');
  });

  it('joins mixed chunks by keeping only text chunks in stored order', () => {
    const chunks: OutputChunk[] = [
      nonTextChunk('init'),
      textChunk('first text'),
      nonTextChunk('tool_use'),
      textChunk('second text'),
      nonTextChunk('complete'),
    ];
    expect(synthesizeOutputTail(chunks)).toBe('first text\nsecond text');
  });

  it('skips text chunks whose data.text is non-string or missing without error', () => {
    const chunks: OutputChunk[] = [
      textChunk('kept'),
      textChunk(123 as unknown),
      textChunk(undefined),
      textChunk(null),
      { type: 'text', data: null, timestamp: '2026-07-09T00:00:00.000Z' },
      { type: 'text', data: undefined, timestamp: '2026-07-09T00:00:00.000Z' },
      { type: 'text', data: {}, timestamp: '2026-07-09T00:00:00.000Z' },
      textChunk('also kept'),
    ];
    expect(synthesizeOutputTail(chunks)).toBe('kept\nalso kept');
  });

  it('extracts prose from assistant-envelope chunks (data.message.content[].text)', () => {
    // Real stream-json shape: OutputCapture stores the whole envelope as
    // `data` with the chunk typed 'text'. The agent's text is nested.
    const assistantChunk = (text: string): OutputChunk => ({
      type: 'text',
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      },
      timestamp: '2026-07-09T00:00:00.000Z',
    });
    const chunks: OutputChunk[] = [
      nonTextChunk('init'),
      assistantChunk('working on T007'),
      assistantChunk('Implementation complete. All 37 tasks done.'),
    ];
    expect(synthesizeOutputTail(chunks)).toBe(
      'working on T007\nImplementation complete. All 37 tasks done.',
    );
  });

  it('concatenates multiple text blocks within one assistant message and skips tool_use blocks', () => {
    const chunks: OutputChunk[] = [
      {
        type: 'text',
        data: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'first block' },
              { type: 'tool_use', name: 'Write', input: {} },
              { type: 'text', text: 'second block' },
            ],
          },
        },
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ];
    expect(synthesizeOutputTail(chunks)).toBe('first block\nsecond block');
  });

  it('includes a result-envelope string only when it is not a duplicate of the last assistant text', () => {
    const finalText = 'Implementation complete.';
    const withDuplicateResult: OutputChunk[] = [
      {
        type: 'text',
        data: { type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
        timestamp: '2026-07-09T00:00:00.000Z',
      },
      {
        type: 'text',
        data: { type: 'result', subtype: 'success', result: finalText },
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ];
    // Duplicate result is dropped → the message appears once.
    expect(synthesizeOutputTail(withDuplicateResult)).toBe(finalText);

    // Result-only (no assistant text) → the result string is the tail.
    const resultOnly: OutputChunk[] = [
      { type: 'text', data: { type: 'result', result: 'terminal summary' }, timestamp: '2026-07-09T00:00:00.000Z' },
    ];
    expect(synthesizeOutputTail(resultOnly)).toBe('terminal summary');
  });

  it('bounds adversarial 10 000 x 500-byte text chunks to ≤ 4200 bytes with truncation marker (SC-002)', () => {
    const bigLine = 'x'.repeat(500);
    const chunks: OutputChunk[] = Array.from({ length: 10_000 }, () => textChunk(bigLine));
    const result = synthesizeOutputTail(chunks);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4200);
    expect(result.startsWith(MARKER_PREFIX)).toBe(true);
  });
});
