import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputCapture, type SSEEventEmitter } from '../output-capture.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

describe('OutputCapture', () => {
  let capture: OutputCapture;
  let emitter: SSEEventEmitter;

  beforeEach(() => {
    emitter = vi.fn();
    capture = new OutputCapture('wf-123', mockLogger, emitter);
  });

  describe('JSON line parsing', () => {
    it('parses a single JSON line into an OutputChunk', () => {
      capture.processChunk('{"type":"init","data":{}}\n');
      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('init');
    });

    it('parses multiple JSON lines into multiple OutputChunks', () => {
      capture.processChunk('{"type":"init","data":{}}\n{"type":"complete","data":{}}\n');
      const output = capture.getOutput();
      expect(output).toHaveLength(2);
      expect(output[0].type).toBe('init');
      expect(output[1].type).toBe('complete');
    });
  });

  describe('partial line buffering', () => {
    it('buffers partial lines and completes on next chunk', () => {
      capture.processChunk('{"type":');
      expect(capture.getOutput()).toHaveLength(0);

      capture.processChunk('"text"}\n');
      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('text');
    });
  });

  describe('malformed JSON', () => {
    it('treats non-JSON lines as text chunks', () => {
      capture.processChunk('this is not json\n');
      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('text');
      expect(output[0].data).toEqual({ text: 'this is not json' });
    });
  });

  describe('flush()', () => {
    it('processes remaining data in the line buffer', () => {
      capture.processChunk('{"type":"text"}');
      // No newline, so nothing parsed yet
      expect(capture.getOutput()).toHaveLength(0);

      capture.flush();
      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('text');
    });
  });

  describe('SSE event emission', () => {
    it('emits step:started for init chunks', () => {
      capture.processChunk('{"type":"init","data":{}}\n');
      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'step:started',
          workflowId: 'wf-123',
        }),
      );
    });

    it('emits step:completed for complete chunks', () => {
      capture.processChunk('{"type":"complete","data":{}}\n');
      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'step:completed',
          workflowId: 'wf-123',
        }),
      );
    });

    it('does NOT emit for error chunks (just logs)', () => {
      capture.processChunk('{"type":"error","message":"fail"}\n');
      expect(emitter).not.toHaveBeenCalled();
    });
  });

  describe('no emitter', () => {
    it('works without an emitter (no crash)', () => {
      const captureNoEmitter = new OutputCapture('wf-456', mockLogger);
      expect(() => {
        captureNoEmitter.processChunk('{"type":"init","data":{}}\n');
        captureNoEmitter.processChunk('{"type":"complete","data":{}}\n');
      }).not.toThrow();
      expect(captureNoEmitter.getOutput()).toHaveLength(2);
    });
  });

  describe('clear()', () => {
    it('clears the output buffer', () => {
      capture.processChunk('{"type":"init","data":{}}\n');
      expect(capture.getOutput()).toHaveLength(1);

      capture.clear();
      expect(capture.getOutput()).toHaveLength(0);
    });
  });
});
