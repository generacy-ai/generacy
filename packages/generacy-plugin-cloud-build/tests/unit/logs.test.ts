/**
 * Unit tests for log streaming.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogStream, createLogStream, collectLogs } from '../../src/streaming/log-stream.js';
import type { LogFetcher, LogChunk } from '../../src/streaming/types.js';
import type { LogEntry } from '../../src/types/logs.js';
import type { Logger } from 'pino';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

// Create a mock log entry
const createLogEntry = (message: string, index: number): LogEntry => ({
  timestamp: new Date(Date.now() + index * 1000),
  severity: 'INFO',
  message,
  insertId: `log-${index}`,
});

describe('LogStream', () => {
  let mockFetcher: LogFetcher;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetcher = {
      fetchLogs: vi.fn(),
      getBuildStatus: vi.fn(),
    };
  });

  describe('async iteration', () => {
    it('should yield log entries from fetcher', async () => {
      const entries = [
        createLogEntry('Log 1', 0),
        createLogEntry('Log 2', 1),
      ];

      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          entries,
          nextOffset: 2,
          isComplete: true,
        });

      const stream = new LogStream('build-123', mockFetcher, mockLogger);
      const collected: LogEntry[] = [];

      for await (const entry of stream) {
        collected.push(entry);
      }

      expect(collected).toHaveLength(2);
      expect(collected[0]?.message).toBe('Log 1');
      expect(collected[1]?.message).toBe('Log 2');
    });

    it('should complete when isComplete is true', async () => {
      const chunk: LogChunk = {
        entries: [createLogEntry('Log 1', 0), createLogEntry('Log 2', 1)],
        nextOffset: 2,
        isComplete: true,
      };

      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>).mockResolvedValue(chunk);

      const stream = new LogStream('build-123', mockFetcher, mockLogger);
      const collected: LogEntry[] = [];

      for await (const entry of stream) {
        collected.push(entry);
      }

      expect(collected).toHaveLength(2);
      expect(collected[0]?.message).toBe('Log 1');
      expect(collected[1]?.message).toBe('Log 2');
    });

    it('should call fetchLogs with build id and offset', async () => {
      const chunk: LogChunk = {
        entries: [createLogEntry('Log 1', 0)],
        nextOffset: 1,
        isComplete: true,
      };

      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>).mockResolvedValue(chunk);

      const stream = new LogStream('build-123', mockFetcher, mockLogger);
      await collectLogs(stream);

      expect(mockFetcher.fetchLogs).toHaveBeenCalledWith('build-123', 0);
    });
  });

  describe('error handling', () => {
    it('should throw on fetch error', async () => {
      const error = new Error('Fetch failed');
      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const stream = new LogStream('build-123', mockFetcher, mockLogger);

      await expect(async () => {
        for await (const _ of stream) {
          // Should throw
        }
      }).rejects.toThrow('Fetch failed');
    });
  });

  describe('options', () => {
    it('should respect start offset', async () => {
      const chunk: LogChunk = {
        entries: [createLogEntry('Log 1', 0)],
        nextOffset: 11,
        isComplete: true,
      };

      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>).mockResolvedValue(chunk);

      const stream = new LogStream('build-123', mockFetcher, mockLogger, {
        startOffset: 10,
      });

      await collectLogs(stream);

      expect(mockFetcher.fetchLogs).toHaveBeenCalledWith('build-123', 10);
    });

    it('should use default polling interval when not specified', async () => {
      const chunk: LogChunk = {
        entries: [],
        nextOffset: 0,
        isComplete: true,
      };

      (mockFetcher.fetchLogs as ReturnType<typeof vi.fn>).mockResolvedValue(chunk);

      const stream = new LogStream('build-123', mockFetcher, mockLogger);
      await collectLogs(stream);

      // Just verify it completes without error
      expect(mockFetcher.fetchLogs).toHaveBeenCalled();
    });
  });
});

describe('createLogStream', () => {
  it('should create a LogStream instance', () => {
    const fetcher: LogFetcher = {
      fetchLogs: vi.fn(),
      getBuildStatus: vi.fn(),
    };

    const stream = createLogStream('build-123', fetcher, mockLogger);

    expect(stream).toBeInstanceOf(LogStream);
  });
});

describe('collectLogs', () => {
  it('should collect all entries from stream', async () => {
    const entries = [
      createLogEntry('Log 1', 0),
      createLogEntry('Log 2', 1),
      createLogEntry('Log 3', 2),
    ];

    const fetcher: LogFetcher = {
      fetchLogs: vi.fn().mockResolvedValue({
        entries,
        nextOffset: 3,
        isComplete: true,
      }),
      getBuildStatus: vi.fn(),
    };

    const stream = createLogStream('build-123', fetcher, mockLogger);
    const collected = await collectLogs(stream);

    expect(collected).toHaveLength(3);
    expect(collected.map(e => e.message)).toEqual(['Log 1', 'Log 2', 'Log 3']);
  });

  it('should return empty array for empty stream', async () => {
    const fetcher: LogFetcher = {
      fetchLogs: vi.fn().mockResolvedValue({
        entries: [],
        nextOffset: 0,
        isComplete: true,
      }),
      getBuildStatus: vi.fn(),
    };

    const stream = createLogStream('build-123', fetcher, mockLogger);
    const collected = await collectLogs(stream);

    expect(collected).toHaveLength(0);
  });
});
