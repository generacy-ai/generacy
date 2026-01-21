import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { COMMANDS, EXTENSION_ID, CONFIG_KEYS, DEFAULTS } from '../constants';

// Mock vscode module
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
  };

  const mockExtensionContext = {
    subscriptions: [],
    extensionPath: '/mock/extension/path',
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockConfiguration = {
    get: vi.fn((key: string) => {
      const defaults: Record<string, unknown> = {
        [CONFIG_KEYS.workflowDirectory]: DEFAULTS.workflowDirectory,
        [CONFIG_KEYS.defaultTemplate]: DEFAULTS.defaultTemplate,
        [CONFIG_KEYS.cloudEndpoint]: DEFAULTS.cloudEndpoint,
        [CONFIG_KEYS.telemetryEnabled]: DEFAULTS.telemetryEnabled,
      };
      return defaults[key];
    }),
    update: vi.fn(),
    has: vi.fn(() => true),
    inspect: vi.fn(),
  };

  return {
    window: {
      createOutputChannel: vi.fn(() => mockOutputChannel),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn((_command: string, _callback: () => void) => ({
        dispose: vi.fn(),
      })),
    },
    workspace: {
      getConfiguration: vi.fn(() => mockConfiguration),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    extensions: {
      getExtension: vi.fn(() => ({
        packageJSON: { version: '0.1.0' },
      })),
    },
    ExtensionContext: mockExtensionContext,
  };
});

// Import after mock setup
import * as extension from '../extension';

describe('Generacy Extension', () => {
  let mockContext: vscode.ExtensionContext;
  let vscode: typeof import('vscode');

  beforeEach(async () => {
    vi.clearAllMocks();
    vscode = await import('vscode');
    mockContext = {
      subscriptions: [],
      extensionPath: '/mock/extension/path',
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
        keys: vi.fn(() => []),
        setKeysForSync: vi.fn(),
      },
      workspaceState: {
        get: vi.fn(),
        update: vi.fn(),
        keys: vi.fn(() => []),
      },
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(() => {
    extension.deactivate();
  });

  describe('activate', () => {
    it('should create an output channel', () => {
      extension.activate(mockContext);

      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Generacy');
    });

    it('should register all commands', () => {
      extension.activate(mockContext);

      const expectedCommands = Object.values(COMMANDS);
      expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(expectedCommands.length);

      for (const command of expectedCommands) {
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
          command,
          expect.any(Function)
        );
      }
    });

    it('should add command disposables to subscriptions', () => {
      extension.activate(mockContext);

      const commandCount = Object.values(COMMANDS).length;
      // Commands + configuration change listener
      expect(mockContext.subscriptions.length).toBeGreaterThanOrEqual(commandCount);
    });

    it('should set up configuration change listener', () => {
      extension.activate(mockContext);

      expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled();
    });

    it('should read workflow directory configuration', () => {
      extension.activate(mockContext);

      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('generacy');
    });
  });

  describe('deactivate', () => {
    it('should dispose output channel on deactivation', () => {
      extension.activate(mockContext);
      const outputChannel = (vscode.window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results[0]?.value;

      extension.deactivate();

      expect(outputChannel.dispose).toHaveBeenCalled();
    });

    it('should handle deactivation when not activated', () => {
      // Should not throw
      expect(() => extension.deactivate()).not.toThrow();
    });
  });
});

describe('Constants', () => {
  it('should have correct extension ID', () => {
    expect(EXTENSION_ID).toBe('generacy-ai.generacy-extension');
  });

  it('should have all required commands', () => {
    expect(COMMANDS).toHaveProperty('createWorkflow');
    expect(COMMANDS).toHaveProperty('runWorkflow');
    expect(COMMANDS).toHaveProperty('debugWorkflow');
    expect(COMMANDS).toHaveProperty('validateWorkflow');
    expect(COMMANDS).toHaveProperty('refreshExplorer');
  });

  it('should have all required config keys', () => {
    expect(CONFIG_KEYS).toHaveProperty('workflowDirectory');
    expect(CONFIG_KEYS).toHaveProperty('defaultTemplate');
    expect(CONFIG_KEYS).toHaveProperty('cloudEndpoint');
    expect(CONFIG_KEYS).toHaveProperty('telemetryEnabled');
  });

  it('should have sensible defaults', () => {
    expect(DEFAULTS.workflowDirectory).toBe('.generacy');
    expect(DEFAULTS.cloudEndpoint).toContain('generacy.ai');
    expect(DEFAULTS.telemetryEnabled).toBe(false);
  });
});
