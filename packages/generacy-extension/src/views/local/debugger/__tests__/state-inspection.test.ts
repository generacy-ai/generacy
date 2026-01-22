/**
 * Tests for state inspection and replay components.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';

// Mock vscode module
vi.mock('vscode', () => ({
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState: number
    ) {}
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    contextValue?: string;
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: unknown
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  MarkdownString: class {
    private parts: string[] = [];
    appendMarkdown(text: string): this {
      this.parts.push(text);
      return this;
    }
    appendCodeblock(code: string, _lang: string): this {
      this.parts.push(code);
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
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
  },
  window: {
    createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(),
  },
  env: {
    clipboard: {
      writeText: vi.fn(),
    },
  },
}));

// Mock debug module
vi.mock('../../../../debug', () => ({
  getDebugExecutionState: vi.fn(() => ({
    onStateChange: vi.fn(() => ({ dispose: vi.fn() })),
    getScopes: vi.fn(() => [
      { name: 'Local', variablesReference: 1001, expensive: false },
      { name: 'Phase', variablesReference: 1002, expensive: false },
      { name: 'Workflow', variablesReference: 1003, expensive: false },
      { name: 'Environment', variablesReference: 1004, expensive: false },
    ]),
    getVariables: vi.fn(() => [
      { name: 'testVar', value: '"hello"', type: 'string', variablesReference: 0 },
    ]),
    getWorkflowState: vi.fn(() => ({
      name: 'test-workflow',
      filePath: '/test/workflow.yaml',
      status: 'paused',
      currentPhaseIndex: 0,
      phases: [
        {
          name: 'build',
          status: 'running',
          currentStepIndex: 0,
          steps: [
            { name: 'step1', phaseName: 'build', status: 'completed', variables: new Map() },
            { name: 'step2', phaseName: 'build', status: 'running', variables: new Map() },
          ],
          variables: new Map(),
        },
      ],
      variables: new Map(),
      environment: new Map([['PATH', '/usr/bin']]),
      outputs: new Map(),
    })),
    getHistory: vi.fn(() => [
      { timestamp: Date.now(), type: 'step', phaseName: 'build', stepName: 'step1', action: 'start' },
      { timestamp: Date.now() + 100, type: 'step', phaseName: 'build', stepName: 'step1', action: 'complete' },
    ]),
    reset: vi.fn(),
    setVariable: vi.fn(),
    setOutput: vi.fn(),
  })),
  resetDebugExecutionState: vi.fn(),
}));

// Mock session
vi.mock('../session', () => ({
  getDebugSession: vi.fn(() => ({
    isActive: vi.fn(() => true),
    isPaused: vi.fn(() => true),
    addEventListener: vi.fn(() => ({ dispose: vi.fn() })),
    getContext: vi.fn(() => ({
      env: { PATH: '/usr/bin' },
      variables: { myVar: 'test' },
      outputs: {},
      phaseOutputs: {},
    })),
    getPosition: vi.fn(() => ({
      phaseIndex: 0,
      stepIndex: 1,
      phaseName: 'build',
      stepName: 'step2',
      atPhaseStart: false,
    })),
    terminate: vi.fn(),
    start: vi.fn(),
  })),
  DebugSession: {
    getInstance: vi.fn(),
    resetInstance: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../../../utils', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('VariablesViewProvider', () => {
  let VariablesViewProvider: typeof import('../variables-view').VariablesViewProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../variables-view');
    VariablesViewProvider = module.VariablesViewProvider;
  });

  it('should be constructable', () => {
    const provider = new VariablesViewProvider();
    expect(provider).toBeDefined();
    provider.dispose();
  });

  it('should implement TreeDataProvider interface', () => {
    const provider = new VariablesViewProvider();
    expect(typeof provider.getTreeItem).toBe('function');
    expect(typeof provider.getChildren).toBe('function');
    expect(provider.onDidChangeTreeData).toBeDefined();
    provider.dispose();
  });

  it('should have a refresh method', () => {
    const provider = new VariablesViewProvider();
    expect(typeof provider.refresh).toBe('function');
    provider.dispose();
  });
});

describe('WatchExpressionsManager', () => {
  let WatchExpressionsManager: typeof import('../watch-expressions').WatchExpressionsManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../watch-expressions');
    WatchExpressionsManager = module.WatchExpressionsManager;
    WatchExpressionsManager.resetInstance();
  });

  afterEach(() => {
    WatchExpressionsManager.resetInstance();
  });

  it('should be a singleton', () => {
    const instance1 = WatchExpressionsManager.getInstance();
    const instance2 = WatchExpressionsManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should add watch expressions', () => {
    const manager = WatchExpressionsManager.getInstance();
    const expr = manager.add('env.PATH');
    expect(expr).toBeDefined();
    expect(expr.expression).toBe('env.PATH');
    expect(expr.id).toBeDefined();
  });

  it('should remove watch expressions', () => {
    const manager = WatchExpressionsManager.getInstance();
    const expr = manager.add('test');
    expect(manager.getAll()).toHaveLength(1);
    manager.remove(expr.id);
    expect(manager.getAll()).toHaveLength(0);
  });

  it('should edit watch expressions', () => {
    const manager = WatchExpressionsManager.getInstance();
    const expr = manager.add('old');
    manager.edit(expr.id, 'new');
    const updated = manager.get(expr.id);
    expect(updated?.expression).toBe('new');
  });

  it('should clear all watch expressions', () => {
    const manager = WatchExpressionsManager.getInstance();
    manager.add('expr1');
    manager.add('expr2');
    manager.add('expr3');
    expect(manager.getAll()).toHaveLength(3);
    manager.clear();
    expect(manager.getAll()).toHaveLength(0);
  });
});

describe('ReplayController', () => {
  let ReplayController: typeof import('../replay-controller').ReplayController;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../replay-controller');
    ReplayController = module.ReplayController;
    ReplayController.resetInstance();
  });

  afterEach(() => {
    ReplayController.resetInstance();
  });

  it('should be a singleton', () => {
    const instance1 = ReplayController.getInstance();
    const instance2 = ReplayController.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should get available replay points from history', () => {
    const controller = ReplayController.getInstance();
    const points = controller.getAvailableReplayPoints();
    expect(Array.isArray(points)).toBe(true);
  });

  it('should track replay state', () => {
    const controller = ReplayController.getInstance();
    expect(controller.isReplaying()).toBe(false);
    expect(controller.getCurrentReplayPoint()).toBeUndefined();
  });
});

describe('ExecutionHistoryProvider', () => {
  let ExecutionHistoryProvider: typeof import('../history-panel').ExecutionHistoryProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../history-panel');
    ExecutionHistoryProvider = module.ExecutionHistoryProvider;
  });

  it('should be constructable', () => {
    const provider = new ExecutionHistoryProvider();
    expect(provider).toBeDefined();
    provider.dispose();
  });

  it('should implement TreeDataProvider interface', () => {
    const provider = new ExecutionHistoryProvider();
    expect(typeof provider.getTreeItem).toBe('function');
    expect(typeof provider.getChildren).toBe('function');
    expect(provider.onDidChangeTreeData).toBeDefined();
    provider.dispose();
  });

  it('should have toggle methods', () => {
    const provider = new ExecutionHistoryProvider();
    expect(typeof provider.toggleGroupByPhase).toBe('function');
    expect(typeof provider.toggleShowVariables).toBe('function');
    expect(typeof provider.toggleShowOutputs).toBe('function');
    provider.dispose();
  });
});

describe('ErrorAnalysisManager', () => {
  let ErrorAnalysisManager: typeof import('../error-analysis').ErrorAnalysisManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../error-analysis');
    ErrorAnalysisManager = module.ErrorAnalysisManager;
    ErrorAnalysisManager.resetInstance();
  });

  afterEach(() => {
    ErrorAnalysisManager.resetInstance();
  });

  it('should be a singleton', () => {
    const instance1 = ErrorAnalysisManager.getInstance();
    const instance2 = ErrorAnalysisManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should start with no errors', () => {
    const manager = ErrorAnalysisManager.getInstance();
    expect(manager.getAllErrors()).toHaveLength(0);
    expect(manager.getLatestError()).toBeUndefined();
  });

  it('should clear all errors', () => {
    const manager = ErrorAnalysisManager.getInstance();
    manager.clear();
    expect(manager.getAllErrors()).toHaveLength(0);
  });

  it('should have onErrorAdded event', () => {
    const manager = ErrorAnalysisManager.getInstance();
    expect(manager.onErrorAdded).toBeDefined();
  });
});

describe('getExecutionStatistics', () => {
  let getExecutionStatistics: typeof import('../history-panel').getExecutionStatistics;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../history-panel');
    getExecutionStatistics = module.getExecutionStatistics;
  });

  it('should return statistics object', () => {
    const stats = getExecutionStatistics();
    expect(stats).toHaveProperty('totalSteps');
    expect(stats).toHaveProperty('completedSteps');
    expect(stats).toHaveProperty('failedSteps');
    expect(stats).toHaveProperty('skippedSteps');
    expect(stats).toHaveProperty('totalDuration');
    expect(stats).toHaveProperty('averageStepDuration');
  });

  it('should return numeric values', () => {
    const stats = getExecutionStatistics();
    expect(typeof stats.totalSteps).toBe('number');
    expect(typeof stats.completedSteps).toBe('number');
    expect(typeof stats.totalDuration).toBe('number');
  });
});
