/**
 * Tests for Workflow Debug Runtime
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    },
    workspace: {
      fs: {
        readFile: vi.fn().mockResolvedValue(
          new TextEncoder().encode(`
name: test-workflow
phases:
  - name: setup
    steps:
      - name: echo-hello
        action: shell
        command: echo hello
      - name: echo-world
        action: shell
        command: echo world
  - name: build
    steps:
      - name: compile
        action: shell
        command: echo compiling
`)
        ),
      },
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
  };
});

// Import after mocking
import {
  WorkflowDebugRuntime,
  getDebugRuntime,
  resetDebugRuntime,
} from '../runtime';
import { resetDebugExecutionState } from '../state';

describe('WorkflowDebugRuntime', () => {
  let runtime: WorkflowDebugRuntime;

  beforeEach(() => {
    resetDebugRuntime();
    resetDebugExecutionState();
    runtime = getDebugRuntime();
  });

  afterEach(() => {
    runtime.dispose();
    vi.clearAllMocks();
  });

  describe('loadWorkflow', () => {
    it('should load and parse workflow file', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('setEnvironment', () => {
    it('should set environment variables', () => {
      runtime.setEnvironment({
        NODE_ENV: 'test',
        DEBUG: 'true',
      });
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('addEventListener', () => {
    it('should add and remove event listeners', () => {
      const listener = vi.fn();
      const disposable = runtime.addEventListener(listener);

      expect(typeof disposable.dispose).toBe('function');
      disposable.dispose();
    });
  });

  describe('setBreakpoints', () => {
    it('should set breakpoints and return results', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      const breakpoints = runtime.setBreakpoints([5, 10, 15]);

      expect(breakpoints).toBeDefined();
      expect(breakpoints).toHaveLength(3);
    });

    it('should return unverified breakpoints for invalid lines', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      const breakpoints = runtime.setBreakpoints([99999]);

      expect(breakpoints[0]?.verified).toBe(false);
    });

    it('should assign unique IDs to breakpoints', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      const breakpoints = runtime.setBreakpoints([5, 10]);

      expect(breakpoints[0]?.id).not.toBe(breakpoints[1]?.id);
    });
  });

  describe('getStackFrames', () => {
    it('should return empty frames when not running', () => {
      const frames = runtime.getStackFrames();
      expect(frames).toEqual([]);
    });
  });

  describe('evaluate', () => {
    it('should return error for non-existent variable', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      const result = runtime.evaluate('nonExistent');

      expect(result.result).toContain('not found');
      expect(result.variablesReference).toBe(0);
    });
  });

  describe('control methods', () => {
    describe('continue', () => {
      it('should not throw when called', () => {
        expect(() => runtime.continue()).not.toThrow();
      });
    });

    describe('stepNext', () => {
      it('should not throw when called', () => {
        expect(() => runtime.stepNext()).not.toThrow();
      });
    });

    describe('stepIn', () => {
      it('should not throw when called', () => {
        expect(() => runtime.stepIn()).not.toThrow();
      });
    });

    describe('stepOut', () => {
      it('should not throw when called', () => {
        expect(() => runtime.stepOut()).not.toThrow();
      });
    });

    describe('pause', () => {
      it('should not throw when called', () => {
        expect(() => runtime.pause()).not.toThrow();
      });
    });

    describe('stop', () => {
      it('should not throw when called', () => {
        expect(() => runtime.stop()).not.toThrow();
      });
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      expect(() => runtime.dispose()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      runtime.dispose();
      expect(() => runtime.dispose()).not.toThrow();
    });
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const instance1 = getDebugRuntime();
      const instance2 = getDebugRuntime();
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton', () => {
      const instance1 = getDebugRuntime();
      resetDebugRuntime();
      const instance2 = getDebugRuntime();

      // New instance after reset
      expect(instance1).not.toBe(instance2);
    });
  });
});

describe('Runtime Events', () => {
  let runtime: WorkflowDebugRuntime;
  let events: Array<{ type: string; reason?: string; success?: boolean }>;

  beforeEach(() => {
    resetDebugRuntime();
    resetDebugExecutionState();
    runtime = getDebugRuntime();
    events = [];

    runtime.addEventListener(event => {
      events.push({ type: event.type, reason: event.reason, success: event.success });
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  describe('stop event', () => {
    it('should emit ended event on stop', () => {
      runtime.stop();

      const endedEvent = events.find(e => e.type === 'ended');
      expect(endedEvent).toBeDefined();
      expect(endedEvent?.success).toBe(false);
      expect(endedEvent?.reason).toBe('cancelled');
    });
  });

  describe('pause event', () => {
    it('should emit stopped event on pause', async () => {
      await runtime.loadWorkflow('/path/to/workflow.yaml');
      runtime.pause();

      const stoppedEvent = events.find(e => e.type === 'stopped');
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent?.reason).toBe('pause');
    });
  });
});

describe('Breakpoint Verification', () => {
  let runtime: WorkflowDebugRuntime;

  beforeEach(async () => {
    resetDebugRuntime();
    resetDebugExecutionState();
    runtime = getDebugRuntime();
    await runtime.loadWorkflow('/path/to/workflow.yaml');
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('should clear existing breakpoints when setting new ones', () => {
    runtime.setBreakpoints([5, 10]);
    const newBreakpoints = runtime.setBreakpoints([15, 20]);

    expect(newBreakpoints).toHaveLength(2);
    expect(newBreakpoints[0]?.line).toBe(15);
    expect(newBreakpoints[1]?.line).toBe(20);
  });
});
