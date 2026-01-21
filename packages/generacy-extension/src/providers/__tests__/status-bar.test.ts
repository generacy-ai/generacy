import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock status bar item outside the factory so it can be accessed in tests
const mockStatusBarItem = {
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  text: '',
  tooltip: '',
  backgroundColor: undefined as unknown,
  command: undefined as unknown,
  name: undefined as unknown,
};

// Mock vscode module - must be first due to hoisting
vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
    showInformationMessage: vi.fn(() => Promise.resolve()),
    showWarningMessage: vi.fn(() => Promise.resolve()),
    showErrorMessage: vi.fn(() => Promise.resolve()),
    withProgress: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
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
    toString(): string {
      return this.parts.join('');
    }
  },
  Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
  ProgressLocation: {
    Notification: 15,
  },
}));

// Mock the runner module
const mockExecutor = {
  addEventListener: vi.fn(() => ({ dispose: vi.fn() })),
  getStatus: vi.fn(() => 'idle'),
  isRunning: vi.fn(() => false),
  getCurrentExecution: vi.fn(() => undefined),
  cancel: vi.fn(),
};

vi.mock('../../views/local/runner', () => ({
  getWorkflowExecutor: () => mockExecutor,
}));

// Mock the utils module
vi.mock('../../utils', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import * as vscode from 'vscode';
import {
  ExecutionStatusBarProvider,
  getExecutionStatusBarProvider,
  initializeExecutionStatusBar,
} from '../status-bar';

describe('ExecutionStatusBarProvider', () => {
  let provider: ExecutionStatusBarProvider;
  let eventListener: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock status bar item properties
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.backgroundColor = undefined;

    // Capture the event listener when addEventListener is called
    mockExecutor.addEventListener.mockImplementation((listener: (event: unknown) => void) => {
      eventListener = listener;
      return { dispose: vi.fn() };
    });

    // Reset singleton
    ExecutionStatusBarProvider.resetInstance();
    provider = getExecutionStatusBarProvider();
  });

  afterEach(() => {
    provider?.dispose();
    eventListener = undefined;
  });

  describe('initialization', () => {
    it('should create status bar item with correct properties', () => {
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Left,
        100
      );
    });

    it('should subscribe to executor events', () => {
      expect(mockExecutor.addEventListener).toHaveBeenCalled();
    });

    it('should return same instance on multiple calls', () => {
      const provider2 = getExecutionStatusBarProvider();
      expect(provider2).toBe(provider);
    });
  });

  describe('execution events', () => {
    it('should show status bar on execution start', () => {
      expect(eventListener).toBeDefined();

      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        message: 'Starting workflow',
      });

      expect(mockStatusBarItem.show).toHaveBeenCalled();
      expect(mockStatusBarItem.text).toContain('test-workflow');
    });

    it('should update status on phase start', () => {
      // First start execution
      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      // Then start a phase
      eventListener?.({
        type: 'phase:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        phaseName: 'build',
      });

      expect(mockStatusBarItem.text).toContain('build');
    });

    it('should update status on step start', () => {
      // Start execution
      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      // Start phase
      eventListener?.({
        type: 'phase:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        phaseName: 'build',
      });

      // Start step
      eventListener?.({
        type: 'step:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        phaseName: 'build',
        stepName: 'compile',
      });

      expect(mockStatusBarItem.text).toContain('compile');
    });

    it('should show completion message on success', () => {
      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      eventListener?.({
        type: 'execution:complete',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        data: {
          status: 'completed',
          duration: 5000,
          phaseResults: [],
        },
      });

      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    });

    it('should show error message on failure', () => {
      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      eventListener?.({
        type: 'execution:error',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
        data: {
          status: 'failed',
          duration: 3000,
          phaseResults: [],
        },
      });

      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('should show warning on cancellation', () => {
      eventListener?.({
        type: 'execution:start',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      eventListener?.({
        type: 'execution:cancel',
        timestamp: Date.now(),
        workflowName: 'test-workflow',
      });

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should dispose status bar item', () => {
      provider.dispose();
      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });

    it('should clear singleton on reset', () => {
      ExecutionStatusBarProvider.resetInstance();
      const newProvider = getExecutionStatusBarProvider();
      expect(newProvider).not.toBe(provider);
    });
  });
});

describe('initializeExecutionStatusBar', () => {
  it('should initialize provider with context', () => {
    const mockContext = {
      subscriptions: [] as unknown[],
    };

    ExecutionStatusBarProvider.resetInstance();
    initializeExecutionStatusBar(mockContext as never);

    // Should register the show output command
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'generacy.showExecutionOutput',
      expect.any(Function)
    );
  });
});
