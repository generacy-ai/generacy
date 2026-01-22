import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { COMMANDS, EXTENSION_ID, CONFIG_KEYS, DEFAULTS } from '../constants';

// Mock yaml module
vi.mock('yaml', () => ({
  parse: vi.fn(() => ({
    name: 'Test Workflow',
    phases: [],
  })),
}));

// Mock vscode module
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
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
    // Tree view classes needed by explorer
    TreeItem: class {
      label: string;
      collapsibleState: number;
      contextValue?: string;
      resourceUri?: unknown;
      iconPath?: unknown;
      tooltip?: unknown;
      description?: string;
      command?: unknown;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    ThemeIcon: class {
      id: string;
      color?: unknown;
      constructor(id: string, color?: unknown) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    MarkdownString: class {
      private parts: string[] = [];
      appendMarkdown(text: string): this {
        this.parts.push(text);
        return this;
      }
      toString(): string {
        return this.parts.join('');
      }
    },
    FileDecoration: class {
      badge?: string;
      tooltip?: string;
      color?: unknown;
      constructor(badge?: string, tooltip?: string, color?: unknown) {
        this.badge = badge;
        this.tooltip = tooltip;
        this.color = color;
      }
    },
    EventEmitter: class<T> {
      private listeners: Array<(e: T) => void> = [];
      event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
      };
      fire(data: T) {
        this.listeners.forEach((l) => l(data));
      }
      dispose() {
        this.listeners = [];
      }
    },
    window: {
      createOutputChannel: vi.fn(() => mockOutputChannel),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      createTreeView: vi.fn(() => ({
        dispose: vi.fn(),
      })),
      registerFileDecorationProvider: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
      onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
      createTerminal: vi.fn(() => ({
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        processId: Promise.resolve(123),
      })),
      createStatusBarItem: vi.fn(() => ({
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
        text: '',
        tooltip: '',
        command: '',
      })),
    },
    commands: {
      registerCommand: vi.fn((_command: string, _callback: () => void) => ({
        dispose: vi.fn(),
      })),
      executeCommand: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn(() => mockConfiguration),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      workspaceFolders: [{ uri: { fsPath: '/workspace', path: '/workspace', toString: () => 'file:///workspace' } }],
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      findFiles: vi.fn(async () => []),
      fs: {
        stat: vi.fn(async () => ({})),
        readFile: vi.fn(async () => Buffer.from('')),
        rename: vi.fn(),
        delete: vi.fn(),
        copy: vi.fn(),
      },
      openTextDocument: vi.fn(),
    },
    extensions: {
      getExtension: vi.fn(() => ({
        packageJSON: { version: '0.1.0' },
      })),
    },
    ExtensionContext: mockExtensionContext,
    env: {
      isTelemetryEnabled: true,
    },
    Uri: {
      file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
      parse: (str: string) => ({ fsPath: str.replace('file://', ''), toString: () => str }),
      joinPath: vi.fn((base: { path?: string; fsPath?: string }, ...segments: string[]) => {
        const basePath = base.path || base.fsPath || '';
        return {
          fsPath: `${basePath}/${segments.join('/')}`,
          path: `${basePath}/${segments.join('/')}`,
          toString: () => `file://${basePath}/${segments.join('/')}`,
        };
      }),
    },
    RelativePattern: class {
      base: unknown;
      pattern: string;
      constructor(base: unknown, pattern: string) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
    // CodeLens and CodeAction related exports
    CodeLens: class {
      constructor(
        public range: unknown,
        public command?: unknown
      ) {}
    },
    CodeAction: class {
      diagnostics?: unknown[];
      isPreferred?: boolean;
      edit?: unknown;
      command?: unknown;
      constructor(
        public title: string,
        public kind?: unknown
      ) {}
    },
    CodeActionKind: {
      QuickFix: 'quickfix',
      Refactor: 'refactor',
      RefactorExtract: 'refactor.extract',
    },
    Range: class {
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number
      ) {}
    },
    Position: class {
      constructor(
        public line: number,
        public character: number
      ) {}
    },
    WorkspaceEdit: class {
      insert = vi.fn();
      replace = vi.fn();
      delete = vi.fn();
    },
    languages: {
      registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    CompletionItemKind: {
      Text: 0,
      Method: 1,
      Function: 2,
      Constructor: 3,
      Field: 4,
      Variable: 5,
      Class: 6,
      Interface: 7,
      Module: 8,
      Property: 9,
      Unit: 10,
      Value: 11,
      Enum: 12,
      Keyword: 13,
      Snippet: 14,
      Color: 15,
      File: 16,
      Reference: 17,
      Folder: 18,
      EnumMember: 19,
      Constant: 20,
      Struct: 21,
      Event: 22,
      Operator: 23,
      TypeParameter: 24,
    },
    CompletionItem: class {
      label: string;
      kind?: number;
      detail?: string;
      documentation?: string;
      insertText?: string;
      constructor(label: string, kind?: number) {
        this.label = label;
        this.kind = kind;
      }
    },
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
      // At least all COMMANDS should be registered (other modules like status-bar may add more)
      const registerCommandCalls = (vscode.commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(registerCommandCalls).toBeGreaterThanOrEqual(expectedCommands.length);

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
    expect(COMMANDS).toHaveProperty('renameWorkflow');
    expect(COMMANDS).toHaveProperty('deleteWorkflow');
    expect(COMMANDS).toHaveProperty('duplicateWorkflow');
    expect(COMMANDS).toHaveProperty('openWorkflow');
    expect(COMMANDS).toHaveProperty('revealInExplorer');
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
