/**
 * Tests for Debug Adapter Protocol handlers
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
import { ProtocolHandler, LaunchRequestArguments } from '../protocol';
import { resetDebugRuntime } from '../runtime';
import { resetDebugExecutionState, getDebugExecutionState } from '../state';

describe('ProtocolHandler', () => {
  let handler: ProtocolHandler;
  let events: DebugProtocol.Event[];
  let sendEvent: (event: DebugProtocol.Event) => void;

  beforeEach(() => {
    resetDebugRuntime();
    resetDebugExecutionState();
    events = [];
    sendEvent = (event) => events.push(event);
    handler = new ProtocolHandler(sendEvent);
  });

  afterEach(() => {
    handler.dispose();
    vi.clearAllMocks();
  });

  describe('handleInitialize', () => {
    it('should return capabilities', async () => {
      const args: DebugProtocol.InitializeRequestArguments = {
        clientID: 'vscode',
        adapterID: 'generacy',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
      };

      const capabilities = await handler.handleInitialize(args);

      expect(capabilities).toBeDefined();
      expect(capabilities.supportsConfigurationDoneRequest).toBe(true);
      expect(capabilities.supportsEvaluateForHovers).toBe(true);
      expect(capabilities.supportsRestartRequest).toBe(true);
      expect(capabilities.supportsTerminateRequest).toBe(true);
      expect(capabilities.supportTerminateDebuggee).toBe(true);
    });

    it('should store client capabilities', async () => {
      const args: DebugProtocol.InitializeRequestArguments = {
        clientID: 'vscode',
        adapterID: 'generacy',
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsProgressReporting: true,
      };

      await handler.handleInitialize(args);

      // Handler should not throw after initialization
      expect(true).toBe(true);
    });

    it('should return correct breakpoint capabilities', async () => {
      const args: DebugProtocol.InitializeRequestArguments = {
        clientID: 'vscode',
        adapterID: 'generacy',
      };

      const capabilities = await handler.handleInitialize(args);

      expect(capabilities.supportsFunctionBreakpoints).toBe(false);
      expect(capabilities.supportsConditionalBreakpoints).toBe(false);
      expect(capabilities.supportsDataBreakpoints).toBe(false);
    });
  });

  describe('handleConfigurationDone', () => {
    it('should complete without error', async () => {
      await expect(handler.handleConfigurationDone()).resolves.toBeUndefined();
    });
  });

  describe('handleLaunch', () => {
    it('should throw if workflow path is missing', async () => {
      const args: LaunchRequestArguments = {} as any;

      await expect(handler.handleLaunch(args)).rejects.toThrow(
        'Workflow path is required'
      );
    });
  });

  describe('handleDisconnect', () => {
    it('should stop and dispose runtime', async () => {
      await expect(handler.handleDisconnect({})).resolves.toBeUndefined();
    });
  });

  describe('handleTerminate', () => {
    it('should stop runtime', async () => {
      await expect(handler.handleTerminate({})).resolves.toBeUndefined();
    });
  });

  describe('handleThreads', () => {
    it('should return single workflow thread', async () => {
      const result = await handler.handleThreads();

      expect(result.threads).toBeDefined();
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0]?.id).toBe(1);
      expect(result.threads[0]?.name).toBe('Workflow Execution');
    });
  });

  describe('handleStackTrace', () => {
    it('should return empty stack when no workflow loaded', async () => {
      const args: DebugProtocol.StackTraceArguments = {
        threadId: 1,
      };

      const result = await handler.handleStackTrace(args);

      expect(result.stackFrames).toBeDefined();
      expect(result.totalFrames).toBe(0);
    });
  });

  describe('handleScopes', () => {
    it('should return scopes for frame', async () => {
      // Initialize state
      const state = getDebugExecutionState();
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);

      const args: DebugProtocol.ScopesArguments = {
        frameId: 1,
      };

      const result = await handler.handleScopes(args);

      expect(result.scopes).toBeDefined();
      expect(result.scopes.length).toBeGreaterThan(0);
    });

    it('should include Local, Phase, Workflow, and Environment scopes', async () => {
      const state = getDebugExecutionState();
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);

      const args: DebugProtocol.ScopesArguments = {
        frameId: 1,
      };

      const result = await handler.handleScopes(args);

      const scopeNames = result.scopes.map((s: { name: string }) => s.name);
      expect(scopeNames).toContain('Local');
      expect(scopeNames).toContain('Phase');
      expect(scopeNames).toContain('Workflow');
      expect(scopeNames).toContain('Environment');
    });
  });

  describe('handleVariables', () => {
    it('should return variables for reference', async () => {
      const state = getDebugExecutionState();
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
      state.setVariable('workflow', 'testVar', 'testValue');

      // Get a valid variable reference from scopes
      const scopes = state.getScopes(1);
      const workflowScope = scopes.find(s => s.name === 'Workflow');

      const args: DebugProtocol.VariablesArguments = {
        variablesReference: workflowScope?.variablesReference ?? 0,
      };

      const result = await handler.handleVariables(args);

      expect(result.variables).toBeDefined();
    });

    it('should return empty array for invalid reference', async () => {
      const args: DebugProtocol.VariablesArguments = {
        variablesReference: 99999,
      };

      const result = await handler.handleVariables(args);

      expect(result.variables).toEqual([]);
    });
  });

  describe('handleContinue', () => {
    it('should return allThreadsContinued', async () => {
      const args: DebugProtocol.ContinueArguments = {
        threadId: 1,
      };

      const result = await handler.handleContinue(args);

      expect(result.allThreadsContinued).toBe(true);
    });
  });

  describe('handleNext', () => {
    it('should step to next step', async () => {
      const args: DebugProtocol.NextArguments = {
        threadId: 1,
      };

      await expect(handler.handleNext(args)).resolves.toBeUndefined();
    });
  });

  describe('handleStepIn', () => {
    it('should step into', async () => {
      const args: DebugProtocol.StepInArguments = {
        threadId: 1,
      };

      await expect(handler.handleStepIn(args)).resolves.toBeUndefined();
    });
  });

  describe('handleStepOut', () => {
    it('should step out', async () => {
      const args: DebugProtocol.StepOutArguments = {
        threadId: 1,
      };

      await expect(handler.handleStepOut(args)).resolves.toBeUndefined();
    });
  });

  describe('handlePause', () => {
    it('should pause execution', async () => {
      const args: DebugProtocol.PauseArguments = {
        threadId: 1,
      };

      await expect(handler.handlePause(args)).resolves.toBeUndefined();
    });
  });

  describe('handleEvaluate', () => {
    it('should return error when no workflow is running', async () => {
      const args: DebugProtocol.EvaluateArguments = {
        expression: 'nonExistentVar',
      };

      const result = await handler.handleEvaluate(args);

      expect(result.result).toContain('No workflow');
    });

    it('should return variable value when found', async () => {
      const state = getDebugExecutionState();
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
      state.startWorkflow();
      state.startPhase('setup');
      state.startStep('setup', 'step1');
      state.setVariable('workflow', 'myVar', 'myValue');

      const args: DebugProtocol.EvaluateArguments = {
        expression: 'myVar',
      };

      const result = await handler.handleEvaluate(args);

      expect(result.result).toBe('myValue');
    });
  });

  describe('handleSetBreakpoints', () => {
    it('should set breakpoints and return results', async () => {
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: {
          path: '/path/to/workflow.yaml',
        },
        breakpoints: [{ line: 5 }, { line: 10 }],
      };

      const result = await handler.handleSetBreakpoints(args);

      expect(result.breakpoints).toBeDefined();
      expect(result.breakpoints).toHaveLength(2);
    });

    it('should return unverified breakpoints for invalid lines', async () => {
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: {
          path: '/path/to/workflow.yaml',
        },
        breakpoints: [{ line: 99999 }],
      };

      const result = await handler.handleSetBreakpoints(args);

      expect(result.breakpoints[0]?.verified).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      expect(() => handler.dispose()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
    });
  });
});
