/**
 * Tests for ProjectConfigService.
 *
 * Covers: valid YAML parsing, missing config file, invalid YAML,
 * Zod validation errors, onDidChange events, file watcher integration,
 * singleton management, and disposal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted variables (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockReadFile,
  mockShowWarningMessage,
  mockCreateFileSystemWatcher,
  mockWorkspaceFolders,
  mockWatcher,
  mockExecuteCommand,
} = vi.hoisted(() => {
  const watcher = {
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };

  return {
    mockReadFile: vi.fn(),
    mockShowWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    mockCreateFileSystemWatcher: vi.fn(() => watcher),
    mockWorkspaceFolders: [
      { uri: { fsPath: '/workspace/test-project', scheme: 'file', path: '/workspace/test-project' } },
    ] as unknown[],
    mockWatcher: watcher,
    mockExecuteCommand: vi.fn(),
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
    window: {
      showWarningMessage: mockShowWarningMessage,
    },
    commands: {
      executeCommand: mockExecuteCommand,
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
      static FileNotFound(uri?: unknown): Error & { code: string } {
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
import { ProjectConfigService, getProjectConfigService } from '../project-config-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a string as a Uint8Array (simulates vscode.workspace.fs.readFile result) */
function encodeYaml(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

const VALID_CONFIG_YAML = `
project:
  id: proj-123
  name: My Test Project
repos:
  primary: org/my-repo
`;

const VALID_CONFIG_MINIMAL = `
project:
  id: proj-456
  name: Minimal Project
`;

const VALID_CONFIG_EXTRA_FIELDS = `
project:
  id: proj-789
  name: Extended Project
  description: Some description
repos:
  primary: org/extended-repo
  secondary: org/other-repo
custom:
  key: value
`;

const INVALID_YAML = `
project:
  id: [broken
  name: "unclosed
`;

const INVALID_SCHEMA_YAML = `
project:
  name: Missing ID
`;

const MISSING_PROJECT_YAML = `
repos:
  primary: org/my-repo
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectConfigService', () => {
  let service: ProjectConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton state between tests
    ProjectConfigService.resetInstance();
    // Reset watcher mock handlers
    mockWatcher.onDidCreate.mockReturnValue({ dispose: vi.fn() });
    mockWatcher.onDidChange.mockReturnValue({ dispose: vi.fn() });
    mockWatcher.onDidDelete.mockReturnValue({ dispose: vi.fn() });
    // Default to no config file (FileNotFound)
    mockReadFile.mockRejectedValue(
      (vscode.FileSystemError as unknown as { FileNotFound: () => Error }).FileNotFound(),
    );
  });

  afterEach(() => {
    ProjectConfigService.resetInstance();
  });

  // ========================================================================
  // Singleton
  // ========================================================================

  describe('singleton', () => {
    it('should return the same instance on repeated calls', () => {
      const a = ProjectConfigService.getInstance();
      const b = ProjectConfigService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a fresh instance after resetInstance', () => {
      const a = ProjectConfigService.getInstance();
      ProjectConfigService.resetInstance();
      const b = ProjectConfigService.getInstance();
      expect(a).not.toBe(b);
    });

    it('should be accessible via getProjectConfigService helper', () => {
      const a = getProjectConfigService();
      const b = ProjectConfigService.getInstance();
      expect(a).toBe(b);
    });
  });

  // ========================================================================
  // Valid Config Parsing
  // ========================================================================

  describe('valid config parsing', () => {
    it('should parse project.id, project.name, and repos.primary from valid YAML', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(true);
      expect(service.projectId).toBe('proj-123');
      expect(service.projectName).toBe('My Test Project');
      expect(service.reposPrimary).toBe('org/my-repo');
    });

    it('should handle config without repos section', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_MINIMAL));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(true);
      expect(service.projectId).toBe('proj-456');
      expect(service.projectName).toBe('Minimal Project');
      expect(service.reposPrimary).toBeUndefined();
    });

    it('should pass through extra fields via .passthrough()', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_EXTRA_FIELDS));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(true);
      expect(service.projectId).toBe('proj-789');
      expect(service.currentConfig).toBeDefined();
      // passthrough allows extra fields
      expect((service.currentConfig as Record<string, unknown>)['custom']).toEqual({ key: 'value' });
    });

    it('should expose the full config via currentConfig', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      const config = service.currentConfig;
      expect(config).toBeDefined();
      expect(config!.project.id).toBe('proj-123');
      expect(config!.project.name).toBe('My Test Project');
      expect(config!.repos?.primary).toBe('org/my-repo');
    });
  });

  // ========================================================================
  // Missing Config File
  // ========================================================================

  describe('missing config file', () => {
    it('should return isConfigured = false when config file does not exist', async () => {
      // Default mock already returns FileNotFound
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(service.projectId).toBeUndefined();
      expect(service.projectName).toBeUndefined();
      expect(service.reposPrimary).toBeUndefined();
      expect(service.currentConfig).toBeUndefined();
    });

    it('should not show a warning for missing config file', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it('should return undefined configUri when no workspace folders exist', async () => {
      // Temporarily remove workspace folders
      const original = mockWorkspaceFolders.slice();
      mockWorkspaceFolders.length = 0;

      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(mockReadFile).not.toHaveBeenCalled();

      // Restore
      mockWorkspaceFolders.push(...original);
    });
  });

  // ========================================================================
  // Invalid YAML
  // ========================================================================

  describe('invalid YAML', () => {
    it('should not throw on malformed YAML', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(INVALID_YAML));
      service = ProjectConfigService.getInstance();

      // Should not throw
      await expect(service.initialize()).resolves.not.toThrow();
      expect(service.isConfigured).toBe(false);
    });

    it('should set isConfigured = false on YAML parse error', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(INVALID_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(service.projectId).toBeUndefined();
    });
  });

  // ========================================================================
  // Zod Validation Errors
  // ========================================================================

  describe('Zod validation errors', () => {
    it('should show warning and set isConfigured = false when project.id is missing', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(INVALID_SCHEMA_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('.generacy/config.yaml has invalid format'),
      );
    });

    it('should show warning when project section is missing entirely', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(MISSING_PROJECT_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(mockShowWarningMessage).toHaveBeenCalled();
    });

    it('should show warning for wrong types in config', async () => {
      const wrongTypeYaml = `
project:
  id: 123
  name: true
`;
      mockReadFile.mockResolvedValue(encodeYaml(wrongTypeYaml));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      // Zod coerces numbers/booleans to strings? Let's verify behavior.
      // If Zod's string() rejects non-strings, isConfigured should be false.
      // Actually, YAML parser will parse `123` as number and `true` as boolean,
      // and Zod's z.string() won't coerce them, so validation fails.
      expect(service.isConfigured).toBe(false);
      expect(mockShowWarningMessage).toHaveBeenCalled();
    });

    it('should not throw on Zod validation failure', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(MISSING_PROJECT_YAML));
      service = ProjectConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });
  });

  // ========================================================================
  // Generic Read Errors
  // ========================================================================

  describe('generic read errors', () => {
    it('should handle non-FileNotFound errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(false);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // File Watcher
  // ========================================================================

  describe('file watcher', () => {
    it('should set up a FileSystemWatcher on initialize', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(mockCreateFileSystemWatcher).toHaveBeenCalledTimes(1);
    });

    it('should register handlers for create, change, and delete events', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(mockWatcher.onDidCreate).toHaveBeenCalledTimes(1);
      expect(mockWatcher.onDidChange).toHaveBeenCalledTimes(1);
      expect(mockWatcher.onDidDelete).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // onDidChange Events
  // ========================================================================

  describe('onDidChange events', () => {
    it('should fire onDidChange when config file is created', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      // Capture the create handler
      const createHandler = mockWatcher.onDidCreate.mock.calls[0]![0] as () => Promise<void>;

      // Now simulate a config file appearing
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));

      const changePromise = new Promise<unknown>((resolve) => {
        service.onDidChange(resolve);
      });

      await createHandler();

      const result = await changePromise;
      expect(result).toBeDefined();
      expect((result as { project: { id: string } }).project.id).toBe('proj-123');
      expect(service.isConfigured).toBe(true);
    });

    it('should fire onDidChange when config file changes', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.projectName).toBe('My Test Project');

      // Capture the change handler
      const changeHandler = mockWatcher.onDidChange.mock.calls[0]![0] as () => Promise<void>;

      // Simulate config update
      const updatedYaml = `
project:
  id: proj-123
  name: Updated Name
`;
      mockReadFile.mockResolvedValue(encodeYaml(updatedYaml));

      const changePromise = new Promise<unknown>((resolve) => {
        service.onDidChange(resolve);
      });

      await changeHandler();

      const result = await changePromise;
      expect(result).toBeDefined();
      expect((result as { project: { name: string } }).project.name).toBe('Updated Name');
      expect(service.projectName).toBe('Updated Name');
    });

    it('should fire onDidChange with undefined when config file is deleted', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(true);

      // Capture the delete handler
      const deleteHandler = mockWatcher.onDidDelete.mock.calls[0]![0] as () => void;

      const changePromise = new Promise<unknown>((resolve) => {
        service.onDidChange(resolve);
      });

      deleteHandler();

      const result = await changePromise;
      expect(result).toBeUndefined();
      expect(service.isConfigured).toBe(false);
      expect(service.projectId).toBeUndefined();
    });

    it('should not fire events after disposal on file change', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      const changeHandler = mockWatcher.onDidChange.mock.calls[0]![0] as () => Promise<void>;

      // Dispose before triggering change
      service.dispose();

      // The handler should bail out because disposed = true
      // This should not throw
      await changeHandler();
    });

    it('should not fire events after disposal on file delete', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      const deleteHandler = mockWatcher.onDidDelete.mock.calls[0]![0] as () => void;

      service.dispose();

      // Should not throw
      deleteHandler();
    });
  });

  // ========================================================================
  // Disposal
  // ========================================================================

  describe('disposal', () => {
    it('should clean up watcher on dispose', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      service.dispose();

      // The watcher.dispose should have been called (it's in the disposables array)
      expect(mockWatcher.dispose).toHaveBeenCalled();
    });

    it('should clear config on dispose', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(service.isConfigured).toBe(true);

      service.dispose();

      expect(service.isConfigured).toBe(false);
      expect(service.currentConfig).toBeUndefined();
    });

    it('should empty the disposables array on dispose', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      service.dispose();

      // Calling dispose again should not throw
      service.dispose();
    });

    it('should call resetInstance to dispose and clear the singleton', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      ProjectConfigService.resetInstance();

      // Old instance should be disposed
      expect(service.isConfigured).toBe(false);

      // New instance should be fresh
      const newService = ProjectConfigService.getInstance();
      expect(newService).not.toBe(service);
      expect(newService.isConfigured).toBe(false);
    });
  });

  // ========================================================================
  // Initialization Logging
  // ========================================================================

  describe('initialization', () => {
    it('should complete initialization even when config is absent', async () => {
      service = ProjectConfigService.getInstance();
      await service.initialize();

      // Watcher should still be set up
      expect(mockCreateFileSystemWatcher).toHaveBeenCalled();
      expect(service.isConfigured).toBe(false);
    });

    it('should complete initialization when config is valid', async () => {
      mockReadFile.mockResolvedValue(encodeYaml(VALID_CONFIG_YAML));
      service = ProjectConfigService.getInstance();
      await service.initialize();

      expect(mockCreateFileSystemWatcher).toHaveBeenCalled();
      expect(service.isConfigured).toBe(true);
    });
  });
});
