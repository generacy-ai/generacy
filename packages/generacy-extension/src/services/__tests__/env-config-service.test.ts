/**
 * Tests for EnvConfigService.
 *
 * Covers: singleton management, missing file, incomplete file, complete file,
 * empty values, file watcher integration, onDidChange events, no-op transitions,
 * and disposal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted variables (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockReadFile,
  mockCreateFileSystemWatcher,
  mockWorkspaceFolders,
  mockWatcher,
} = vi.hoisted(() => {
  const watcher = {
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };

  return {
    mockReadFile: vi.fn(),
    mockCreateFileSystemWatcher: vi.fn(() => watcher),
    mockWorkspaceFolders: [
      { uri: { fsPath: '/workspace/test-project', scheme: 'file', path: '/workspace/test-project' } },
    ] as unknown[],
    mockWatcher: watcher,
  };
});

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------

vi.mock('vscode', () => {
  class MockEventEmitter {
    private handlers: ((e: unknown) => void)[] = [];
    event = (handler: (e: unknown) => void) => {
      this.handlers.push(handler);
      return { dispose: () => { this.handlers = this.handlers.filter((h) => h !== handler); } };
    };
    fire(data: unknown) { this.handlers.forEach((h) => h(data)); }
    dispose() { this.handlers.length = 0; }
  }

  return {
    workspace: {
      get workspaceFolders() { return mockWorkspaceFolders; },
      createFileSystemWatcher: mockCreateFileSystemWatcher,
      fs: {
        readFile: mockReadFile,
      },
    },
    Uri: {
      file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
      joinPath: (base: { path: string }, ...segments: string[]) => {
        const joined = [base.path, ...segments].join('/');
        return { fsPath: joined, scheme: 'file', path: joined };
      },
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    EventEmitter: MockEventEmitter,
    FileSystemError: class extends Error {
      code: string;
      constructor(message?: string) {
        super(message);
        this.code = 'Unknown';
      }
      static FileNotFound(_uri?: unknown): Error & { code: string } {
        const err = new Error('FileNotFound') as Error & { code: string };
        err.code = 'FileNotFound';
        return err;
      }
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
  };
});

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { EnvConfigService, getEnvConfigService } from '../env-config-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

/** Extract the callback registered on a watcher event mock. */
function getWatcherHandler<T extends (...args: unknown[]) => unknown>(
  mock: ReturnType<typeof vi.fn>,
): T {
  return (mock.mock.calls[0] as unknown[])[0] as T;
}

const COMPLETE_ENV = `
GITHUB_TOKEN=ghp_abc123
ANTHROPIC_API_KEY=sk-ant-xyz789
`;

const INCOMPLETE_ENV_GITHUB_ONLY = `
GITHUB_TOKEN=ghp_abc123
ANTHROPIC_API_KEY=
`;

const INCOMPLETE_ENV_ANTHROPIC_ONLY = `
ANTHROPIC_API_KEY=sk-ant-xyz789
`;

const EMPTY_VALUES_ENV = `
GITHUB_TOKEN=
ANTHROPIC_API_KEY=
`;

const COMPLETE_ENV_WITH_COMMENTS = `
# GitHub token
GITHUB_TOKEN=ghp_abc123
# Anthropic key
ANTHROPIC_API_KEY=sk-ant-xyz789
# Optional
REDIS_URL=redis://localhost:6379
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    EnvConfigService.resetInstance();
    mockWatcher.onDidCreate.mockReturnValue({ dispose: vi.fn() });
    mockWatcher.onDidChange.mockReturnValue({ dispose: vi.fn() });
    mockWatcher.onDidDelete.mockReturnValue({ dispose: vi.fn() });
    // Default to file not found
    mockReadFile.mockRejectedValue(
      (vscode.FileSystemError as unknown as { FileNotFound: () => Error }).FileNotFound(),
    );
  });

  afterEach(() => {
    EnvConfigService.resetInstance();
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe('singleton', () => {
    it('should return the same instance on repeated calls', () => {
      const a = EnvConfigService.getInstance();
      const b = EnvConfigService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a fresh instance after resetInstance', () => {
      const a = EnvConfigService.getInstance();
      EnvConfigService.resetInstance();
      const b = EnvConfigService.getInstance();
      expect(a).not.toBe(b);
    });

    it('should be accessible via getEnvConfigService helper', () => {
      const a = getEnvConfigService();
      const b = EnvConfigService.getInstance();
      expect(a).toBe(b);
    });
  });

  // ========================================================================
  // Missing File
  // ========================================================================

  describe('missing file', () => {
    it('should set status to missing when env file does not exist', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('missing');
    });

    it('should set status to missing when no workspace folders exist', async () => {
      const original = mockWorkspaceFolders.slice();
      mockWorkspaceFolders.length = 0;

      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('missing');
      expect(mockReadFile).not.toHaveBeenCalled();

      mockWorkspaceFolders.push(...original);
    });

    it('should set status to missing on non-FileNotFound read errors', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('missing');
    });
  });

  // ========================================================================
  // Incomplete File
  // ========================================================================

  describe('incomplete file', () => {
    it('should set status to incomplete when only GITHUB_TOKEN is set', async () => {
      mockReadFile.mockResolvedValue(encode(INCOMPLETE_ENV_GITHUB_ONLY));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('incomplete');
    });

    it('should set status to incomplete when only ANTHROPIC_API_KEY is set', async () => {
      mockReadFile.mockResolvedValue(encode(INCOMPLETE_ENV_ANTHROPIC_ONLY));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('incomplete');
    });

    it('should treat empty values as missing (status = incomplete)', async () => {
      mockReadFile.mockResolvedValue(encode(EMPTY_VALUES_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('incomplete');
    });
  });

  // ========================================================================
  // Complete File
  // ========================================================================

  describe('complete file', () => {
    it('should set status to ok when both required keys have values', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('ok');
    });

    it('should set status to ok with comments and extra keys', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV_WITH_COMMENTS));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('ok');
    });
  });

  // ========================================================================
  // File Watcher
  // ========================================================================

  describe('file watcher', () => {
    it('should set up a FileSystemWatcher on initialize', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(mockCreateFileSystemWatcher).toHaveBeenCalledTimes(1);
    });

    it('should register handlers for create, change, and delete events', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(mockWatcher.onDidCreate).toHaveBeenCalledTimes(1);
      expect(mockWatcher.onDidChange).toHaveBeenCalledTimes(1);
      expect(mockWatcher.onDidDelete).toHaveBeenCalledTimes(1);
    });

    it('should reload status when file is created', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('missing');

      const createHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidCreate);
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));

      await createHandler();

      expect(service.status).toBe('ok');
    });

    it('should reload status when file changes', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('ok');

      const changeHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidChange);
      mockReadFile.mockResolvedValue(encode(INCOMPLETE_ENV_GITHUB_ONLY));

      await changeHandler();

      expect(service.status).toBe('incomplete');
    });

    it('should set status to missing when file is deleted', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('ok');

      const deleteHandler = getWatcherHandler<() => void>(mockWatcher.onDidDelete);
      deleteHandler();

      expect(service.status).toBe('missing');
    });
  });

  // ========================================================================
  // onDidChange Events
  // ========================================================================

  describe('onDidChange events', () => {
    it('should fire when status transitions from missing to ok', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const createHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidCreate);
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));

      const changePromise = new Promise<string>((resolve) => {
        service.onDidChange(resolve);
      });

      await createHandler();

      const newStatus = await changePromise;
      expect(newStatus).toBe('ok');
    });

    it('should fire when status transitions from ok to incomplete', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const changeHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidChange);
      mockReadFile.mockResolvedValue(encode(INCOMPLETE_ENV_GITHUB_ONLY));

      const changePromise = new Promise<string>((resolve) => {
        service.onDidChange(resolve);
      });

      await changeHandler();

      const newStatus = await changePromise;
      expect(newStatus).toBe('incomplete');
    });

    it('should fire when status transitions from ok to missing (delete)', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const deleteHandler = getWatcherHandler<() => void>(mockWatcher.onDidDelete);

      const changePromise = new Promise<string>((resolve) => {
        service.onDidChange(resolve);
      });

      deleteHandler();

      const newStatus = await changePromise;
      expect(newStatus).toBe('missing');
    });

    it('should NOT fire when status stays the same on change', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const changeHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidChange);
      // File changes but still has both keys
      mockReadFile.mockResolvedValue(encode('GITHUB_TOKEN=new\nANTHROPIC_API_KEY=also-new\n'));

      const listener = vi.fn();
      service.onDidChange(listener);

      await changeHandler();

      expect(listener).not.toHaveBeenCalled();
      expect(service.status).toBe('ok');
    });

    it('should NOT fire when status stays missing on delete', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('missing');

      const deleteHandler = getWatcherHandler<() => void>(mockWatcher.onDidDelete);

      const listener = vi.fn();
      service.onDidChange(listener);

      deleteHandler();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Disposal
  // ========================================================================

  describe('disposal', () => {
    it('should clean up watcher on dispose', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      service.dispose();

      expect(mockWatcher.dispose).toHaveBeenCalled();
    });

    it('should not fire events after dispose on file change', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const changeHandler = getWatcherHandler<() => Promise<void>>(mockWatcher.onDidChange);

      service.dispose();

      // Should not throw
      await changeHandler();
    });

    it('should not fire events after dispose on file delete', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      const deleteHandler = getWatcherHandler<() => void>(mockWatcher.onDidDelete);

      service.dispose();

      // Should not throw
      deleteHandler();
    });

    it('should handle double dispose without error', async () => {
      const service = EnvConfigService.getInstance();
      await service.initialize();

      service.dispose();
      service.dispose();
    });

    it('should dispose old instance on resetInstance and provide fresh one', async () => {
      mockReadFile.mockResolvedValue(encode(COMPLETE_ENV));
      const service = EnvConfigService.getInstance();
      await service.initialize();

      expect(service.status).toBe('ok');

      EnvConfigService.resetInstance();

      const newService = EnvConfigService.getInstance();
      expect(newService).not.toBe(service);
      expect(newService.status).toBe('missing');
    });
  });
});
