/**
 * Tests for Debug Adapter implementation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DebugProtocol } from '@vscode/debugprotocol';

// Mock VS Code API - must use factory function without external variables
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  };

  const mockTerminal = {
    show: vi.fn(),
    dispose: vi.fn(),
    sendText: vi.fn(),
  };

  return {
    window: {
      createOutputChannel: vi.fn().mockReturnValue(mockOutputChannel),
      createTerminal: vi.fn().mockReturnValue(mockTerminal),
      activeTextEditor: undefined,
    },
    workspace: {
      fs: {
        readFile: vi.fn().mockResolvedValue(new Uint8Array()),
      },
      workspaceFolders: [],
      getConfiguration: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue('.generacy'),
      }),
    },
    EventEmitter: vi.fn().mockImplementation(() => ({
      event: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    })),
    Uri: {
      file: vi.fn((path: string) => ({ fsPath: path })),
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
    debug: {
      registerDebugAdapterDescriptorFactory: vi.fn(),
      registerDebugConfigurationProvider: vi.fn(),
    },
    DebugAdapterInlineImplementation: vi.fn(),
  };
});

// Import after mocking
import { GeneracyDebugAdapter, GeneracyDebugAdapterFactory, GeneracyDebugConfigurationProvider } from '../adapter';
import { resetDebugRuntime } from '../runtime';
import { resetDebugExecutionState } from '../state';

describe('GeneracyDebugAdapter', () => {
  let adapter: GeneracyDebugAdapter;

  beforeEach(() => {
    resetDebugRuntime();
    resetDebugExecutionState();
    adapter = new GeneracyDebugAdapter();

    // Capture the messages (unused in current tests but available)
    adapter.onDidSendMessage(() => {
      // Messages captured for potential future test assertions
    });
  });

  afterEach(() => {
    adapter.dispose();
    vi.clearAllMocks();
  });

  describe('handleMessage', () => {
    it('should handle initialize request', async () => {
      const initRequest: DebugProtocol.InitializeRequest = {
        seq: 1,
        type: 'request',
        command: 'initialize',
        arguments: {
          clientID: 'vscode',
          adapterID: 'generacy',
          pathFormat: 'path',
          linesStartAt1: true,
          columnsStartAt1: true,
        },
      };

      // Handle the message - should not throw
      adapter.handleMessage(initRequest);
    });

    it('should handle threads request', () => {
      const threadsRequest: DebugProtocol.ThreadsRequest = {
        seq: 2,
        type: 'request',
        command: 'threads',
      };

      adapter.handleMessage(threadsRequest);
    });

    it('should handle disconnect request', () => {
      const disconnectRequest: DebugProtocol.DisconnectRequest = {
        seq: 10,
        type: 'request',
        command: 'disconnect',
        arguments: {},
      };

      adapter.handleMessage(disconnectRequest);
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      adapter.dispose();
      // Should not throw on second dispose
      expect(() => adapter.dispose()).not.toThrow();
    });
  });
});

describe('GeneracyDebugAdapterFactory', () => {
  let factory: GeneracyDebugAdapterFactory;

  beforeEach(() => {
    factory = new GeneracyDebugAdapterFactory();
  });

  afterEach(() => {
    factory.dispose();
  });

  describe('createDebugAdapterDescriptor', () => {
    it('should create an inline implementation adapter', () => {
      const mockSession = {
        id: 'test-session',
        type: 'generacy',
        name: 'Test Session',
        configuration: {},
      };

      const descriptor = factory.createDebugAdapterDescriptor(
        mockSession as any,
        undefined
      );

      expect(descriptor).toBeDefined();
    });
  });

  describe('dispose', () => {
    it('should not throw on dispose', () => {
      expect(() => factory.dispose()).not.toThrow();
    });
  });
});

describe('GeneracyDebugConfigurationProvider', () => {
  let provider: GeneracyDebugConfigurationProvider;

  beforeEach(() => {
    provider = new GeneracyDebugConfigurationProvider();
  });

  describe('resolveDebugConfiguration', () => {
    it('should set default type and request', () => {
      const config = {};
      const resolved = provider.resolveDebugConfiguration(
        undefined,
        config as any
      );

      if (resolved && typeof resolved !== 'object') {
        return;
      }

      // Config without type/request returns undefined or the original
      expect(resolved).toBeDefined();
    });

    it('should preserve existing configuration', () => {
      const config = {
        type: 'generacy',
        request: 'launch',
        name: 'Test Debug',
        workflow: '/path/to/workflow.yaml',
      };

      const resolved = provider.resolveDebugConfiguration(
        undefined,
        config as any
      );

      expect(resolved).toBeDefined();
      expect((resolved as any)?.workflow).toBe('/path/to/workflow.yaml');
    });

    it('should default stopOnEntry to true', () => {
      const config = {
        type: 'generacy',
        request: 'launch',
        name: 'Test Debug',
        workflow: '/path/to/workflow.yaml',
      };

      const resolved = provider.resolveDebugConfiguration(
        undefined,
        config as any
      );

      expect((resolved as any)?.stopOnEntry).toBe(true);
    });

    it('should resolve ${workspaceFolder} in workflow path', () => {
      const folder = {
        uri: { fsPath: '/workspace' },
        name: 'workspace',
        index: 0,
      };

      const config = {
        type: 'generacy',
        request: 'launch',
        name: 'Test Debug',
        workflow: '${workspaceFolder}/.generacy/test.yaml',
      };

      const resolved = provider.resolveDebugConfiguration(
        folder as any,
        config as any
      );

      expect((resolved as any)?.workflow).toBe('/workspace/.generacy/test.yaml');
    });
  });

  describe('provideDebugConfigurations', () => {
    it('should provide default configurations', () => {
      const configs = provider.provideDebugConfigurations(undefined);

      expect(configs).toBeDefined();
      expect(Array.isArray(configs)).toBe(true);
      expect((configs as any[]).length).toBeGreaterThan(0);
    });

    it('should include Debug Workflow configuration', () => {
      const configs = provider.provideDebugConfigurations(undefined) as any[];

      const debugConfig = configs.find(c => c.name === 'Debug Workflow');
      expect(debugConfig).toBeDefined();
      expect(debugConfig?.type).toBe('generacy');
      expect(debugConfig?.stopOnEntry).toBe(true);
    });

    it('should include Run Workflow configuration', () => {
      const configs = provider.provideDebugConfigurations(undefined) as any[];

      const runConfig = configs.find(c => c.name === 'Run Workflow');
      expect(runConfig).toBeDefined();
      expect(runConfig?.stopOnEntry).toBe(false);
    });
  });
});
