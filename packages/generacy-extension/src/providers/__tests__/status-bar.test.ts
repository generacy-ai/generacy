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
  addEventListener: vi.fn((_listener: (event: unknown) => void) => ({ dispose: vi.fn() })),
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
  CloudJobStatusBarProvider,
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

describe('CloudJobStatusBarProvider', () => {
  let provider: CloudJobStatusBarProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.backgroundColor = undefined;
    provider = new CloudJobStatusBarProvider();
  });

  afterEach(() => {
    provider.dispose();
    vi.useRealTimers();
  });

  describe('flash()', () => {
    it('should set completed flash appearance', () => {
      provider.flash('completed');

      expect(mockStatusBarItem.text).toBe('$(check) Job completed');
      expect(mockStatusBarItem.backgroundColor).toBeUndefined();
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should set failed flash appearance with error background', () => {
      provider.flash('failed');

      expect(mockStatusBarItem.text).toBe('$(error) Job failed');
      expect(mockStatusBarItem.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
      expect((mockStatusBarItem.backgroundColor as vscode.ThemeColor).id).toBe(
        'statusBarItem.errorBackground'
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should set cancelled flash appearance with warning background', () => {
      provider.flash('cancelled');

      expect(mockStatusBarItem.text).toBe('$(stop) Job cancelled');
      expect(mockStatusBarItem.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
      expect((mockStatusBarItem.backgroundColor as vscode.ThemeColor).id).toBe(
        'statusBarItem.warningBackground'
      );
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('should revert to previous text and background after 3000ms', () => {
      // Set up initial state via updateCount
      provider.updateCount(2);
      const previousText = mockStatusBarItem.text;
      const previousBg = mockStatusBarItem.backgroundColor;

      provider.flash('completed');

      // During flash
      expect(mockStatusBarItem.text).toBe('$(check) Job completed');

      // Advance timer to trigger revert
      vi.advanceTimersByTime(3000);

      expect(mockStatusBarItem.text).toBe(previousText);
      expect(mockStatusBarItem.backgroundColor).toBe(previousBg);
    });

    it('should hide status bar after flash revert when currentCount is 0', () => {
      // currentCount defaults to 0 (no updateCount called)
      provider.flash('completed');

      vi.advanceTimersByTime(3000);

      expect(mockStatusBarItem.hide).toHaveBeenCalled();
    });

    it('should not hide status bar after flash revert when currentCount > 0', () => {
      provider.updateCount(3);
      mockStatusBarItem.hide.mockClear();

      provider.flash('failed');

      vi.advanceTimersByTime(3000);

      expect(mockStatusBarItem.hide).not.toHaveBeenCalled();
    });

    it('should clear previous flash timer on rapid sequential flashes', () => {
      provider.updateCount(1);

      // First flash
      provider.flash('completed');
      expect(mockStatusBarItem.text).toBe('$(check) Job completed');

      // Advance partway (not enough to trigger revert)
      vi.advanceTimersByTime(1500);

      // Second flash before first reverts
      provider.flash('failed');
      expect(mockStatusBarItem.text).toBe('$(error) Job failed');

      // Advance past what would have been the first timer's revert
      vi.advanceTimersByTime(1500);

      // Should still show the second flash (first timer was cleared)
      expect(mockStatusBarItem.text).toBe('$(error) Job failed');

      // Advance to complete the second flash timer
      vi.advanceTimersByTime(1500);

      // Now should revert to the state captured by the second flash call
      // (which was the 'completed' flash text, since that was active when flash('failed') was called)
      expect(mockStatusBarItem.text).not.toBe('$(error) Job failed');
    });

    it('should force show status bar item during flash even when count is 0', () => {
      // Count is 0, status bar is hidden
      expect(mockStatusBarItem.show).not.toHaveBeenCalled();

      provider.flash('cancelled');

      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('should clear active flash timer on dispose', () => {
      provider.flash('completed');

      // Dispose before timer fires
      provider.dispose();

      // Advance past the flash timeout — should not throw or cause issues
      vi.advanceTimersByTime(3000);

      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });

    it('should dispose status bar item', () => {
      provider.dispose();
      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
