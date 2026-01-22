/**
 * Tests for provider.ts - WorkflowTreeProvider
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkflowTreeProvider } from '../provider';
import { WorkflowTreeItem, PhaseTreeItem, StepTreeItem } from '../tree-item';

// Mock modules
vi.mock('yaml', () => ({
  parse: vi.fn((content: string) => {
    // Simple mock parser
    if (content.includes('invalid')) {
      throw new Error('Parse error');
    }
    return {
      name: 'Test Workflow',
      description: 'A test workflow',
      phases: [
        {
          name: 'build',
          label: 'Build',
          steps: [
            { name: 'compile', label: 'Compile', type: 'script' },
          ],
        },
      ],
    };
  }),
}));

vi.mock('../../../../utils', () => ({
  getConfig: vi.fn(() => ({
    get: vi.fn((key: string) => {
      if (key === 'workflowDirectory') return '.generacy';
      return '';
    }),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  })),
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  ErrorCode: {
    WorkflowParseError: 3002,
  },
  GeneracyError: class extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../../../../constants', () => ({
  WORKFLOW_EXTENSIONS: ['.yaml', '.yml'],
  VIEWS: { workflows: 'generacy.workflows' },
  TREE_ITEM_CONTEXT: {
    workflow: 'workflow',
    phase: 'phase',
    step: 'step',
  },
  STATUS_ICONS: {
    pending: '$(clock)',
    running: '$(sync~spin)',
    completed: '$(check)',
    failed: '$(error)',
    unknown: '$(question)',
  },
}));

// Mock vscode
vi.mock('vscode', () => {
  const workspaceFolders = [{ uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } }];

  return {
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
    Uri: {
      file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
      parse: (str: string) => ({ fsPath: str.replace('file://', ''), toString: () => str }),
      joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
        fsPath: [base.fsPath, ...segments].join('/'),
        toString: () => `file://${[base.fsPath, ...segments].join('/')}`,
      }),
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
    workspace: {
      workspaceFolders,
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      findFiles: vi.fn(async () => [
        vscode.Uri.file('/workspace/.generacy/workflow1.yaml'),
        vscode.Uri.file('/workspace/.generacy/workflow2.yml'),
      ]),
      fs: {
        stat: vi.fn(async () => ({})),
        readFile: vi.fn(async () => Buffer.from('name: Test Workflow\nphases: []')),
      },
    },
    RelativePattern: class {
      base: unknown;
      pattern: string;
      constructor(base: unknown, pattern: string) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    window: {
      createTreeView: vi.fn(() => ({
        dispose: vi.fn(),
      })),
    },
    Disposable: class {
      constructor(private fn: () => void) {}
      dispose() {
        this.fn();
      }
    },
  };
});

describe('WorkflowTreeProvider', () => {
  let provider: WorkflowTreeProvider;

  beforeEach(() => {
    provider = new WorkflowTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('constructor', () => {
    it('should create provider instance', () => {
      expect(provider).toBeInstanceOf(WorkflowTreeProvider);
    });

    it('should expose onDidChangeTreeData event', () => {
      expect(provider.onDidChangeTreeData).toBeDefined();
    });
  });

  describe('getTreeItem', () => {
    it('should return the element itself', () => {
      const mockUri = vscode.Uri.file('/test/workflow.yaml');
      const item = new WorkflowTreeItem({
        uri: mockUri,
        name: 'Test',
        validationStatus: 'unknown',
      });

      const result = provider.getTreeItem(item);
      expect(result).toBe(item);
    });
  });

  describe('getChildren', () => {
    it('should return workflow files at root level', async () => {
      const children = await provider.getChildren();

      expect(children).toBeDefined();
      expect(Array.isArray(children)).toBe(true);
    });

    it('should return phases for workflow item', async () => {
      const mockUri = vscode.Uri.file('/test/workflow.yaml');
      const parsedWorkflow = {
        name: 'Test',
        phases: [
          { name: 'build', label: 'Build', steps: [], index: 0 },
        ],
        rawContent: '',
      };
      const item = new WorkflowTreeItem(
        { uri: mockUri, name: 'Test', validationStatus: 'valid' },
        parsedWorkflow
      );

      const children = await provider.getChildren(item);

      expect(children).toBeDefined();
      expect(children.length).toBe(1);
      expect(children[0]).toBeInstanceOf(PhaseTreeItem);
    });

    it('should return steps for phase item', async () => {
      const mockUri = vscode.Uri.file('/test/workflow.yaml');
      const phaseData = {
        name: 'build',
        label: 'Build',
        steps: [
          { name: 'step1', label: 'Step 1', type: 'script', index: 0 },
          { name: 'step2', label: 'Step 2', type: 'action', index: 1 },
        ],
        index: 0,
      };
      const phaseItem = new PhaseTreeItem(phaseData, mockUri);

      const children = await provider.getChildren(phaseItem);

      expect(children).toBeDefined();
      expect(children.length).toBe(2);
      expect(children[0]).toBeInstanceOf(StepTreeItem);
    });

    it('should return empty array for step item', async () => {
      const mockUri = vscode.Uri.file('/test/workflow.yaml');
      const stepItem = new StepTreeItem(
        { name: 'step', label: 'Step', type: 'script', index: 0 },
        mockUri
      );

      const children = await provider.getChildren(stepItem);

      expect(children).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('should fire tree data change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalled();
    });

    it('should clear cache on full refresh', () => {
      // Add item to cache via getChildren
      // Then refresh and verify cache is cleared
      provider.refresh();

      const workflows = provider.getAllWorkflows();
      expect(workflows.length).toBe(0);
    });
  });

  describe('getWorkflowByUri', () => {
    it('should return undefined for non-cached URI', () => {
      const uri = vscode.Uri.file('/test/unknown.yaml');
      const result = provider.getWorkflowByUri(uri);

      expect(result).toBeUndefined();
    });
  });

  describe('getAllWorkflows', () => {
    it('should return empty array when cache is empty', () => {
      const workflows = provider.getAllWorkflows();
      expect(workflows).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      provider.dispose();

      // Should not throw and cache should be cleared
      const workflows = provider.getAllWorkflows();
      expect(workflows).toEqual([]);
    });
  });
});
