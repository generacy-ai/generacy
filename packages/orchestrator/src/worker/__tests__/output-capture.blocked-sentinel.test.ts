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

describe('OutputCapture — SPECKIT_IMPLEMENT_BLOCKED sentinel', () => {
  let capture: OutputCapture;
  let emitter: SSEEventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    emitter = vi.fn();
    capture = new OutputCapture('wf-123', mockLogger, emitter);
  });

  it('parses a valid blocked sentinel and populates blocked_on', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["generacy-ai/generacy#1198","#1199"]}\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.blocked_on).toEqual(['generacy-ai/generacy#1198', '#1199']);
  });

  it('last blocked sentinel wins when multiple are emitted', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["a/b#1"]}\n');
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["c/d#2","e/f#3"]}\n');
    const result = capture.implementResult;
    expect(result!.blocked_on).toEqual(['c/d#2', 'e/f#3']);
  });

  it('warns and ignores malformed JSON in blocked sentinel', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {not valid json}\n');
    const result = capture.implementResult;
    expect(result).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ line: 'SPECKIT_IMPLEMENT_BLOCKED: {not valid json}' }),
      expect.stringContaining('Malformed'),
    );
  });

  it('warns and ignores blocked sentinel with missing on array', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"foo":"bar"}\n');
    const result = capture.implementResult;
    expect(result).toBeUndefined();
  });

  it('warns and ignores blocked sentinel with empty on array', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":[]}\n');
    const result = capture.implementResult;
    expect(result).toBeUndefined();
  });

  it('sentinel line is still captured as text output', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["a/b#1"]}\n');
    const output = capture.getOutput();
    const textChunks = output.filter(c => c.type === 'text');
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0]!.data).toEqual({ text: 'SPECKIT_IMPLEMENT_BLOCKED: {"on":["a/b#1"]}' });
  });

  it('coexists with PARTIAL sentinel — blocked_on merges into existing implementResult', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":5,"tasks_remaining":10,"tasks_total":15}\n');
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["a/b#1"]}\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
    expect(result!.tasks_completed).toBe(5);
    expect(result!.tasks_remaining).toBe(10);
    expect(result!.blocked_on).toEqual(['a/b#1']);
  });

  it('BLOCKED sentinel arriving before PARTIAL also merges', () => {
    capture.processChunk('SPECKIT_IMPLEMENT_BLOCKED: {"on":["a/b#1"]}\n');
    capture.processChunk('SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":3,"tasks_remaining":7,"tasks_total":10}\n');
    const result = capture.implementResult;
    expect(result).toBeDefined();
    expect(result!.blocked_on).toEqual(['a/b#1']);
    expect(result!.partial).toBe(true);
    expect(result!.tasks_completed).toBe(3);
  });
});