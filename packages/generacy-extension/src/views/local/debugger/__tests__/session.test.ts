import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode
vi.mock('vscode', () => ({
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
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
  },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    iconPath?: unknown;
    description?: string;
    tooltip?: unknown;
    id?: string;
    command?: unknown;
    constructor(label: string, collapsibleState: number = 0) {
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
    private content = '';
    appendMarkdown(text: string) {
      this.content += text;
      return this;
    }
    toString() {
      return this.content;
    }
  },
}));

// Mock logger
vi.mock('../../../../utils', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock breakpoints
vi.mock('../breakpoints', () => ({
  getBreakpointManager: () => ({
    shouldStopAt: vi.fn().mockReturnValue(undefined),
    resetHitCounts: vi.fn(),
  }),
}));

// Mock output channel
vi.mock('../../runner/output-channel', () => ({
  getRunnerOutputChannel: () => ({
    writePhaseStart: vi.fn(),
    writePhaseComplete: vi.fn(),
    writeStepStart: vi.fn(),
    writeStepComplete: vi.fn(),
  }),
}));

// Mock event bridge
vi.mock('../event-bridge', () => ({
  ExecutorEventBridge: class {
    connect() {}
    disconnect() {}
  },
}));

// Mock executor
vi.mock('../../runner/executor', () => ({
  WorkflowExecutor: {
    getInstance: () => ({
      getExecutionContext: vi.fn().mockReturnValue(undefined),
      executeSingleStep: vi.fn().mockResolvedValue({
        success: true,
        output: 'mock output',
        duration: 100,
        skipped: false,
      }),
    }),
  },
}));

// Mock debug integration
vi.mock('../../runner/debug-integration', () => ({
  getDebugHooks: () => ({
    enable: vi.fn(),
    disable: vi.fn(),
    setBreakpointManagerDelegate: vi.fn(),
    clearBreakpointManagerDelegate: vi.fn(),
  }),
}));

// Mock debug execution state
vi.mock('../../../../debug', () => ({
  getDebugExecutionState: () => ({}),
}));

// Mock error analysis
vi.mock('../error-analysis', () => ({
  getErrorAnalysisManager: () => ({}),
}));

import { DebugSession, getDebugSession, type DebugSessionConfig } from '../session';
import type { ExecutableWorkflow } from '../../runner/types';

describe('DebugSession', () => {
  let session: DebugSession;
  const mockUri = { fsPath: '/test/workflow.yaml', toString: () => 'file:///test/workflow.yaml' };

  const createMockWorkflow = (): ExecutableWorkflow => ({
    name: 'test-workflow',
    description: 'Test workflow',
    phases: [
      {
        name: 'build',
        steps: [
          { name: 'setup', action: 'shell', command: 'echo setup' },
          { name: 'compile', action: 'shell', command: 'echo compile' },
        ],
      },
      {
        name: 'test',
        steps: [
          { name: 'unit', action: 'shell', command: 'echo test' },
        ],
      },
    ],
    env: { NODE_ENV: 'test' },
  });

  const createConfig = (workflow = createMockWorkflow()): DebugSessionConfig => ({
    workflow,
    uri: mockUri as any,
    options: { mode: 'dry-run' },
    stopOnEntry: true,
  });

  beforeEach(() => {
    DebugSession.resetInstance();
    session = getDebugSession();
  });

  afterEach(() => {
    DebugSession.resetInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const instance1 = getDebugSession();
      const instance2 = getDebugSession();
      expect(instance1).toBe(instance2);
    });
  });

  describe('state management', () => {
    it('should start in idle state', () => {
      expect(session.getState()).toBe('idle');
      expect(session.isActive()).toBe(false);
    });

    it('should transition to paused on start with stopOnEntry', async () => {
      const config = createConfig();
      await session.start(config);

      // With stopOnEntry, session should be paused immediately
      expect(session.getState()).toBe('paused');
      expect(session.isActive()).toBe(true);
      expect(session.isPaused()).toBe(true);
    });

    it('should not allow starting when already active', async () => {
      const config = createConfig();
      await session.start(config);

      await expect(session.start(config)).rejects.toThrow(/already active/);
    });
  });

  describe('position tracking', () => {
    it('should initialize position on start', async () => {
      const config = createConfig();
      await session.start(config);

      const position = session.getPosition();
      expect(position).toBeDefined();
      expect(position?.phaseIndex).toBe(0);
      expect(position?.stepIndex).toBe(0);
      expect(position?.phaseName).toBe('build');
      expect(position?.atPhaseStart).toBe(true);
    });
  });

  describe('context management', () => {
    it('should initialize context with environment', async () => {
      const config = createConfig();
      await session.start(config);

      const context = session.getContext();
      expect(context).toBeDefined();
      expect(context?.env).toEqual({ NODE_ENV: 'test' });
      expect(context?.variables).toEqual({});
      expect(context?.outputs).toEqual({});
    });
  });

  describe('stepping', () => {
    it('should step in when paused', async () => {
      const config = createConfig();
      await session.start(config);

      // Session is paused at entry
      expect(session.isPaused()).toBe(true);

      // Listen for second stopped event (after step)
      const stoppedPromise = new Promise<void>((resolve) => {
        session.addEventListener((event) => {
          if (event.type === 'stopped') {
            resolve();
          }
        });
      });

      // Step in should move to next position
      await session.stepIn();

      // Wait for step to complete
      await stoppedPromise;

      // After stepping, should be paused again
      expect(session.isPaused()).toBe(true);
    });

    it('should not step when not paused', async () => {
      // Session is idle
      await expect(session.stepIn()).rejects.toThrow(/No active debug session/);
    });

    it('should step over', async () => {
      const config = createConfig();
      await session.start(config);

      const stoppedPromise = new Promise<void>((resolve) => {
        session.addEventListener((event) => {
          if (event.type === 'stopped') {
            resolve();
          }
        });
      });

      await session.stepOver();
      await stoppedPromise;

      expect(session.isPaused()).toBe(true);
    });

    it('should step out', async () => {
      const config = createConfig();
      await session.start(config);

      const stoppedPromise = new Promise<void>((resolve) => {
        session.addEventListener((event) => {
          if (event.type === 'stopped') {
            resolve();
          }
        });
      });

      await session.stepOut();
      await stoppedPromise;

      expect(session.isPaused()).toBe(true);
    });
  });

  describe('continue', () => {
    it('should continue execution', async () => {
      const config = createConfig();
      await session.start(config);

      // Continue execution
      await session.continue();

      // Session should eventually complete or pause at breakpoint
      // In this test with mocked breakpoints (returning undefined), it should complete
    });

    it('should not continue when not active', async () => {
      await expect(session.continue()).rejects.toThrow(/No active debug session/);
    });
  });

  describe('pause', () => {
    it('should request pause', async () => {
      const config = createConfig();
      await session.start(config);

      await session.pause();
      // Pause is asynchronous, sets a flag
    });

    it('should not pause when not active', async () => {
      await expect(session.pause()).rejects.toThrow(/No active debug session/);
    });
  });

  describe('terminate', () => {
    it('should terminate the session', async () => {
      const config = createConfig();
      await session.start(config);

      session.terminate();

      expect(session.getState()).toBe('idle');
      expect(session.isActive()).toBe(false);
    });

    it('should be safe to terminate idle session', () => {
      expect(() => session.terminate()).not.toThrow();
    });
  });

  describe('events', () => {
    it('should emit started event', async () => {
      const listener = vi.fn();
      session.addEventListener(listener);

      const config = createConfig();
      await session.start(config);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'started' })
      );
    });

    it('should emit stopped event with entry reason', async () => {
      const listener = vi.fn();
      session.addEventListener(listener);

      const config = createConfig();
      config.stopOnEntry = true;
      await session.start(config);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stopped', reason: 'entry' })
      );
    });

    it('should emit terminated event', async () => {
      const listener = vi.fn();
      session.addEventListener(listener);

      const config = createConfig();
      await session.start(config);
      session.terminate();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'terminated' })
      );
    });
  });

  describe('getScopes', () => {
    it('should return all scopes', () => {
      const scopes = session.getScopes();

      expect(scopes).toHaveLength(4);
      expect(scopes.map(s => s.name)).toContain('Environment');
      expect(scopes.map(s => s.name)).toContain('Variables');
      expect(scopes.map(s => s.name)).toContain('Outputs');
      expect(scopes.map(s => s.name)).toContain('Phase Outputs');
    });
  });

  describe('getStackTrace', () => {
    it('should return empty when no session', () => {
      const stack = session.getStackTrace();
      expect(stack).toHaveLength(0);
    });

    it('should return stack frames during session', async () => {
      const config = createConfig();
      await session.start(config);

      const stack = session.getStackTrace();
      expect(stack.length).toBeGreaterThanOrEqual(1);
      expect(stack[0]?.name).toContain('Phase');
    });
  });

  describe('getVariables', () => {
    it('should return empty when no session', () => {
      const vars = session.getVariables('env');
      expect(vars).toEqual({});
    });

    it('should return environment variables', async () => {
      const config = createConfig();
      await session.start(config);

      const vars = session.getVariables('env');
      expect(vars).toEqual({ NODE_ENV: 'test' });
    });
  });
});
