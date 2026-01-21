import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { CONFIG_KEYS, DEFAULTS } from '../../constants';

// Mock vscode module
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    clear: vi.fn(),
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
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      tabGroups: {
        all: [],
        close: vi.fn(),
      },
    },
    commands: {
      registerCommand: vi.fn((_command: string, _callback: () => void) => ({
        dispose: vi.fn(),
      })),
    },
    workspace: {
      getConfiguration: vi.fn(() => mockConfiguration),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      workspaceFolders: [{ uri: { fsPath: '/workspace', path: '/workspace' } }],
      fs: {
        createDirectory: vi.fn(),
        stat: vi.fn(),
        writeFile: vi.fn(),
        readFile: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
      },
      openTextDocument: vi.fn(),
      findFiles: vi.fn(),
    },
    extensions: {
      getExtension: vi.fn(() => ({
        packageJSON: { version: '0.1.0' },
      })),
    },
    env: {
      isTelemetryEnabled: true,
    },
    Uri: {
      joinPath: vi.fn((base: { path: string }, ...segments: string[]) => ({
        fsPath: `${base.path}/${segments.join('/')}`,
        path: `${base.path}/${segments.join('/')}`,
      })),
      file: vi.fn((path: string) => ({
        fsPath: path,
        path: path,
      })),
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3,
    },
    Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
    RelativePattern: vi.fn().mockImplementation((base: { fsPath: string }, pattern: string) => ({
      base,
      pattern,
    })),
    TabInputText: class {
      uri: { fsPath: string };
      constructor(uri: { fsPath: string }) {
        this.uri = uri;
      }
    },
  };
});

// Import after mock setup
import * as workflow from '../workflow';
import { getLogger, getConfig } from '../../utils';

describe('Workflow CRUD Commands', () => {
  let vscode: typeof import('vscode');
  let mockContext: {
    subscriptions: { dispose: () => void }[];
    globalState: { get: Mock; update: Mock; keys: Mock; setKeysForSync: Mock };
    workspaceState: { get: Mock; update: Mock; keys: Mock };
    extensionPath: string;
  };

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
    };

    // Initialize utilities for tests
    const logger = getLogger();
    logger.initialize(mockContext as Parameters<typeof logger.initialize>[0]);
    const config = getConfig();
    config.initialize(mockContext as Parameters<typeof config.initialize>[0]);
  });

  afterEach(() => {
    getLogger().dispose();
    getConfig().dispose();
  });

  describe('createWorkflow', () => {
    it('should show template selection quick pick', async () => {
      // User cancels template selection
      (vscode.window.showQuickPick as Mock).mockResolvedValue(undefined);

      await workflow.createWorkflow();

      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      const call = (vscode.window.showQuickPick as Mock).mock.calls[0];
      expect(call[0]).toHaveLength(3); // 3 templates
      expect(call[1]).toMatchObject({
        placeHolder: 'Select a workflow template',
        title: 'Create New Workflow',
      });
    });

    it('should prompt for workflow name after template selection', async () => {
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: '$(file) Basic',
        templateKey: 'basic',
      });
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);

      await workflow.createWorkflow();

      expect(vscode.window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter workflow name',
        placeHolder: 'my-workflow',
        validateInput: expect.any(Function),
      });
    });

    it('should create workflow file with correct content', async () => {
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: '$(file) Basic',
        templateKey: 'basic',
      });
      (vscode.window.showInputBox as Mock).mockResolvedValue('test-workflow');
      (vscode.workspace.fs.stat as Mock).mockRejectedValue(new Error('File not found'));
      (vscode.workspace.openTextDocument as Mock).mockResolvedValue({});
      (vscode.window.showTextDocument as Mock) = vi.fn().mockResolvedValue(undefined);

      await workflow.createWorkflow();

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalled();
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();

      const writeCall = (vscode.workspace.fs.writeFile as Mock).mock.calls[0];
      const content = new TextDecoder().decode(writeCall[1]);
      expect(content).toContain('name: test-workflow');
      expect(content).toContain('phases:');
    });

    it('should cancel when no template selected', async () => {
      (vscode.window.showQuickPick as Mock).mockResolvedValue(undefined);

      await workflow.createWorkflow();

      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('should cancel when no name provided', async () => {
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: '$(file) Basic',
        templateKey: 'basic',
      });
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);

      await workflow.createWorkflow();

      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('renameWorkflow', () => {
    it('should prompt for new name', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);

      await workflow.renameWorkflow(mockUri as Parameters<typeof workflow.renameWorkflow>[0]);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter new workflow name',
        value: 'test',
        validateInput: expect.any(Function),
      });
    });

    it('should rename file when new name provided', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showInputBox as Mock).mockResolvedValue('new-name');
      (vscode.workspace.fs.stat as Mock).mockRejectedValue(new Error('File not found'));

      await workflow.renameWorkflow(mockUri as Parameters<typeof workflow.renameWorkflow>[0]);

      expect(vscode.workspace.fs.rename).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Renamed workflow to: new-name'
      );
    });

    it('should cancel when same name provided', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showInputBox as Mock).mockResolvedValue('test');

      await workflow.renameWorkflow(mockUri as Parameters<typeof workflow.renameWorkflow>[0]);

      expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();
    });
  });

  describe('deleteWorkflow', () => {
    it('should show confirmation dialog', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showWarningMessage as Mock).mockResolvedValue(undefined);

      await workflow.deleteWorkflow(mockUri as Parameters<typeof workflow.deleteWorkflow>[0]);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Are you sure you want to delete "test"?',
        { modal: true },
        'Delete'
      );
    });

    it('should delete file when confirmed', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showWarningMessage as Mock).mockResolvedValue('Delete');

      await workflow.deleteWorkflow(mockUri as Parameters<typeof workflow.deleteWorkflow>[0]);

      expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(mockUri);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Deleted workflow: test'
      );
    });

    it('should not delete when cancelled', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.window.showWarningMessage as Mock).mockResolvedValue(undefined);

      await workflow.deleteWorkflow(mockUri as Parameters<typeof workflow.deleteWorkflow>[0]);

      expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    });
  });

  describe('duplicateWorkflow', () => {
    it('should prompt for duplicate name', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      (vscode.workspace.fs.stat as Mock).mockRejectedValue(new Error('File not found'));
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);

      await workflow.duplicateWorkflow(mockUri as Parameters<typeof workflow.duplicateWorkflow>[0]);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter name for the duplicate workflow',
        value: 'test-copy',
        validateInput: expect.any(Function),
      });
    });

    it('should create duplicate with updated name', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      const mockContent = new TextEncoder().encode('name: test\nphases:\n  - name: main');

      (vscode.workspace.fs.stat as Mock).mockRejectedValue(new Error('File not found'));
      (vscode.window.showInputBox as Mock).mockResolvedValue('test-copy');
      (vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockContent);
      (vscode.workspace.openTextDocument as Mock).mockResolvedValue({});
      (vscode.window.showTextDocument as Mock) = vi.fn().mockResolvedValue(undefined);

      await workflow.duplicateWorkflow(mockUri as Parameters<typeof workflow.duplicateWorkflow>[0]);

      expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(mockUri);
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();

      const writeCall = (vscode.workspace.fs.writeFile as Mock).mock.calls[0];
      const content = new TextDecoder().decode(writeCall[1]);
      expect(content).toContain('name: test-copy');
    });

    it('should increment copy number if copy already exists', async () => {
      const mockUri = { fsPath: '/workspace/.generacy/test.yaml' };
      const mockContent = new TextEncoder().encode('name: test\nphases:\n  - name: main');

      // First stat call (test-copy) finds file, second (test-copy-2) doesn't
      let statCallCount = 0;
      (vscode.workspace.fs.stat as Mock).mockImplementation(() => {
        statCallCount++;
        if (statCallCount === 1) {
          return Promise.resolve({}); // test-copy exists
        }
        return Promise.reject(new Error('File not found')); // test-copy-2 doesn't exist
      });
      (vscode.window.showInputBox as Mock).mockResolvedValue('test-copy-2');
      (vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockContent);
      (vscode.workspace.openTextDocument as Mock).mockResolvedValue({});
      (vscode.window.showTextDocument as Mock) = vi.fn().mockResolvedValue(undefined);

      await workflow.duplicateWorkflow(mockUri as Parameters<typeof workflow.duplicateWorkflow>[0]);

      // Should have checked test-copy first, then test-copy-2
      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 'test-copy-2',
        })
      );
    });
  });

  describe('workflow name validation', () => {
    it('should validate workflow names correctly', async () => {
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: '$(file) Basic',
        templateKey: 'basic',
      });
      (vscode.window.showInputBox as Mock).mockResolvedValue(undefined);

      await workflow.createWorkflow();

      // Get the validation function from the input box call
      const inputBoxCall = (vscode.window.showInputBox as Mock).mock.calls[0];
      const validateInput = inputBoxCall[0].validateInput;

      // Valid names
      expect(validateInput('my-workflow')).toBeUndefined();
      expect(validateInput('workflow123')).toBeUndefined();
      expect(validateInput('test_workflow')).toBeUndefined();
      expect(validateInput('MyWorkflow')).toBeUndefined();

      // Invalid names
      expect(validateInput('')).toBe('Workflow name is required');
      expect(validateInput('123-invalid')).toContain('must start with a letter');
      expect(validateInput('invalid name')).toContain('must start with a letter');
      expect(validateInput('invalid.name')).toContain('must start with a letter');
      expect(validateInput('a'.repeat(65))).toContain('64 characters or less');
    });
  });
});
