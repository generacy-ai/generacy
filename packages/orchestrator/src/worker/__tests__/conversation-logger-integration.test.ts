import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputCapture, type SSEEventEmitter } from '../output-capture.js';
import type { ConversationLogger } from '../conversation-logger.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

describe('OutputCapture → ConversationLogger integration', () => {
  let capture: OutputCapture;
  let emitter: SSEEventEmitter;
  let mockConversationLogger: { logEvent: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    emitter = vi.fn();
    mockConversationLogger = { logEvent: vi.fn() };
    capture = new OutputCapture(
      'wf-integration',
      mockLogger,
      emitter,
      mockConversationLogger as unknown as ConversationLogger,
    );
  });

  describe('processChunk calls ConversationLogger.logEvent for each parsed chunk', () => {
    it('calls logEvent once for a single JSON line', () => {
      capture.processChunk('{"type":"init","data":{}}\n');

      expect(mockConversationLogger.logEvent).toHaveBeenCalledTimes(1);
      expect(mockConversationLogger.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'init',
          data: { type: 'init', data: {} },
        }),
      );
    });

    it('calls logEvent for each line when multiple JSON lines arrive in one chunk', () => {
      capture.processChunk(
        '{"type":"init","data":{}}\n{"type":"tool_use","name":"Read","id":"t1","input":{}}\n{"type":"complete","data":{}}\n',
      );

      expect(mockConversationLogger.logEvent).toHaveBeenCalledTimes(3);

      expect(mockConversationLogger.logEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: 'init' }),
      );
      expect(mockConversationLogger.logEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: 'tool_use' }),
      );
      expect(mockConversationLogger.logEvent).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ type: 'complete' }),
      );
    });

    it('calls logEvent for error chunks', () => {
      capture.processChunk('{"type":"error","message":"something failed"}\n');

      expect(mockConversationLogger.logEvent).toHaveBeenCalledTimes(1);
      expect(mockConversationLogger.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    it('calls logEvent with OutputChunk including a timestamp', () => {
      capture.processChunk('{"type":"init","data":{}}\n');

      const chunk = mockConversationLogger.logEvent.mock.calls[0]![0];
      expect(chunk).toHaveProperty('timestamp');
      expect(typeof chunk.timestamp).toBe('string');
    });
  });

  describe('sample Claude CLI output stream', () => {
    it('receives all expected events from a realistic multi-line stream', () => {
      // Simulate a realistic Claude CLI session: init → tool_use → tool_result → text → complete
      const lines = [
        '{"type":"init","session_id":"ses-abc-123","data":{}}',
        '{"type":"tool_use","name":"Read","id":"call-1","input":{"file_path":"/src/index.ts"}}',
        '{"type":"tool_result","tool_use_id":"call-1","name":"Read","content":"file contents"}',
        '{"type":"text","data":{"text":"Here is my analysis..."}}',
        '{"type":"complete","data":{"usage":{"input_tokens":100,"output_tokens":50}}}',
      ];

      // Feed lines one by one, as would happen with streaming stdout
      for (const line of lines) {
        capture.processChunk(line + '\n');
      }

      expect(mockConversationLogger.logEvent).toHaveBeenCalledTimes(5);

      // Verify the sequence of event types
      const receivedTypes = mockConversationLogger.logEvent.mock.calls.map(
        (call: unknown[]) => (call[0] as { type: string }).type,
      );
      expect(receivedTypes).toEqual(['init', 'tool_use', 'tool_result', 'text', 'complete']);
    });

    it('handles partial chunks that span multiple processChunk calls', () => {
      // First call: partial JSON, no newline
      capture.processChunk('{"type":"init","ses');
      expect(mockConversationLogger.logEvent).not.toHaveBeenCalled();

      // Second call: completes the line
      capture.processChunk('sion_id":"ses-xyz"}\n');
      expect(mockConversationLogger.logEvent).toHaveBeenCalledTimes(1);
      expect(mockConversationLogger.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'init' }),
      );
    });

    it('preserves full parsed data in the chunk passed to logEvent', () => {
      capture.processChunk(
        '{"type":"tool_use","name":"Edit","id":"call-42","input":{"file_path":"/src/app.ts","old_string":"foo","new_string":"bar"}}\n',
      );

      const chunk = mockConversationLogger.logEvent.mock.calls[0]![0];
      expect(chunk.type).toBe('tool_use');
      expect(chunk.data).toEqual({
        type: 'tool_use',
        name: 'Edit',
        id: 'call-42',
        input: { file_path: '/src/app.ts', old_string: 'foo', new_string: 'bar' },
      });
    });
  });

  describe('no ConversationLogger (undefined)', () => {
    it('does not throw when conversationLogger is undefined', () => {
      const captureNoLogger = new OutputCapture('wf-no-logger', mockLogger, emitter);

      expect(() => {
        captureNoLogger.processChunk('{"type":"init","data":{}}\n');
        captureNoLogger.processChunk('{"type":"tool_use","name":"Read","id":"t1"}\n');
        captureNoLogger.processChunk('{"type":"complete","data":{}}\n');
      }).not.toThrow();

      expect(captureNoLogger.getOutput()).toHaveLength(3);
    });

    it('processes all chunk types without a logger', () => {
      const captureNoLogger = new OutputCapture('wf-no-logger', mockLogger);

      expect(() => {
        captureNoLogger.processChunk('{"type":"init","data":{}}\n');
        captureNoLogger.processChunk('{"type":"tool_use","name":"Read","id":"t1"}\n');
        captureNoLogger.processChunk('{"type":"tool_result","tool_use_id":"t1"}\n');
        captureNoLogger.processChunk('{"type":"text","data":{"text":"hello"}}\n');
        captureNoLogger.processChunk('{"type":"error","message":"oops"}\n');
        captureNoLogger.processChunk('{"type":"complete","data":{}}\n');
        captureNoLogger.processChunk('not json at all\n');
        captureNoLogger.flush();
      }).not.toThrow();

      expect(captureNoLogger.getOutput()).toHaveLength(7);
    });

    it('also works without emitter AND without logger', () => {
      const captureMinimal = new OutputCapture('wf-minimal', mockLogger);

      expect(() => {
        captureMinimal.processChunk('{"type":"init","data":{}}\n');
        captureMinimal.processChunk('{"type":"complete","data":{}}\n');
      }).not.toThrow();

      expect(captureMinimal.getOutput()).toHaveLength(2);
    });
  });
});
