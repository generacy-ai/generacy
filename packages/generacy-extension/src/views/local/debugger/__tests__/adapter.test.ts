import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode
vi.mock('vscode', () => {
  return {
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
    workspace: {
      fs: {
        readFile: vi.fn().mockResolvedValue(Buffer.from(`
name: test-workflow
phases:
  - name: build
    steps:
      - name: setup
        command: echo setup
  - name: test
    steps:
      - name: unit
        command: echo test
`)),
      },
    },
    debug: {
      registerDebugAdapterDescriptorFactory: vi.fn(() => ({ dispose: vi.fn() })),
      registerDebugConfigurationProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      activeTextEditor: undefined,
    },
    DebugAdapterInlineImplementation: class {
      constructor(public adapter: unknown) {}
    },
  };
});

// Mock logger
vi.mock('../../../../utils', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  GeneracyError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  ErrorCode: {
    WorkflowValidationError: 'WORKFLOW_VALIDATION_ERROR',
  },
}));

// Mock constants
vi.mock('../../../../constants', () => ({
  DEBUG_TYPE: 'generacy',
  WORKFLOW_EXTENSIONS: ['.yaml', '.yml'],
}));

// Mock breakpoints
vi.mock('../breakpoints', () => ({
  getBreakpointManager: () => ({
    setBreakpointsForUri: vi.fn().mockImplementation((_uri, bps, resolver) => {
      return bps.map((bp: { line: number }, index: number) => ({
        id: index + 1,
        uri: { fsPath: '/test/workflow.yaml', toString: () => 'file:///test/workflow.yaml' },
        location: resolver(bp.line) || { type: 'step', phaseName: 'test', stepName: 'step', line: bp.line },
        enabled: true,
        verified: true,
        hitCount: 0,
      }));
    }),
    resetHitCounts: vi.fn(),
  }),
}));

// Mock executor
vi.mock('../../runner/executor', () => ({
  WorkflowExecutor: {
    getInstance: () => ({
      getExecutionContext: vi.fn().mockReturnValue(undefined),
    }),
  },
}));

// Mock session
const mockSession = {
  start: vi.fn(),
  continue: vi.fn(),
  stepIn: vi.fn(),
  stepOver: vi.fn(),
  stepOut: vi.fn(),
  pause: vi.fn(),
  terminate: vi.fn(),
  getStackTrace: vi.fn().mockReturnValue([
    { id: 1, name: 'Phase: build', source: '/test/workflow.yaml', line: 1 },
  ]),
  getScopes: vi.fn().mockReturnValue([
    { name: 'Environment', variablesReference: 1 },
    { name: 'Variables', variablesReference: 2 },
  ]),
  getVariables: vi.fn().mockReturnValue({ NODE_ENV: 'test' }),
  getPosition: vi.fn().mockReturnValue({
    phaseIndex: 0,
    stepIndex: 0,
    phaseName: 'build',
    stepName: 'setup',
    atPhaseStart: false,
  }),
  getContext: vi.fn().mockReturnValue({
    env: { NODE_ENV: 'test' },
    variables: {},
    outputs: {},
    phaseOutputs: {},
  }),
  getState: vi.fn().mockReturnValue('paused'),
  addEventListener: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

vi.mock('../session', () => ({
  getDebugSession: () => mockSession,
}));

import { WorkflowDebugAdapter, WorkflowDebugConfigurationProvider, WorkflowDebugAdapterFactory } from '../adapter';

describe('WorkflowDebugAdapter', () => {
  let adapter: WorkflowDebugAdapter;
  let sentMessages: unknown[];

  beforeEach(() => {
    adapter = new WorkflowDebugAdapter();
    sentMessages = [];

    // Capture sent messages
    (adapter as any).onDidSendMessage((msg: unknown) => {
      sentMessages.push(msg);
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    adapter.dispose();
  });

  describe('initialize', () => {
    it('should respond with capabilities', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'initialize',
        seq: 1,
        arguments: {},
      } as any);

      expect(sentMessages).toHaveLength(2); // response + initialized event

      const response = sentMessages[0] as any;
      expect(response.type).toBe('response');
      expect(response.command).toBe('initialize');
      expect(response.success).toBe(true);
      expect(response.body.supportsConfigurationDoneRequest).toBe(true);
      expect(response.body.supportsConditionalBreakpoints).toBe(true);
      expect(response.body.supportsHitConditionalBreakpoints).toBe(true);
      expect(response.body.supportsLogPoints).toBe(true);
    });

    it('should send initialized event', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'initialize',
        seq: 1,
        arguments: {},
      } as any);

      const event = sentMessages[1] as any;
      expect(event.type).toBe('event');
      expect(event.event).toBe('initialized');
    });
  });

  describe('launch', () => {
    it('should start debug session', async () => {
      adapter.handleMessage({
        type: 'request',
        command: 'launch',
        seq: 1,
        arguments: {
          workflow: '/test/workflow.yaml',
          stopOnEntry: true,
        },
      } as any);

      // Wait for async handling
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSession.start).toHaveBeenCalled();

      const response = sentMessages.find((m: any) => m.command === 'launch') as any;
      expect(response.success).toBe(true);
    });
  });

  describe('setBreakpoints', () => {
    it('should set breakpoints and return verified status', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'setBreakpoints',
        seq: 1,
        arguments: {
          source: { path: '/test/workflow.yaml' },
          breakpoints: [
            { line: 5 },
            { line: 10, condition: 'x > 5' },
          ],
        },
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'setBreakpoints') as any;
      expect(response.success).toBe(true);
      expect(response.body.breakpoints).toHaveLength(2);
      expect(response.body.breakpoints[0].verified).toBe(true);
      expect(response.body.breakpoints[1].verified).toBe(true);
    });

    it('should handle empty breakpoints', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'setBreakpoints',
        seq: 1,
        arguments: {
          source: { path: '/test/workflow.yaml' },
          breakpoints: [],
        },
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'setBreakpoints') as any;
      expect(response.success).toBe(true);
      expect(response.body.breakpoints).toHaveLength(0);
    });
  });

  describe('threads', () => {
    it('should return single workflow thread', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'threads',
        seq: 1,
        arguments: {},
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'threads') as any;
      expect(response.success).toBe(true);
      expect(response.body.threads).toHaveLength(1);
      expect(response.body.threads[0].id).toBe(1);
      expect(response.body.threads[0].name).toBe('Workflow Thread');
    });
  });

  describe('stackTrace', () => {
    it('should return stack frames from session', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'stackTrace',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'stackTrace') as any;
      expect(response.success).toBe(true);
      expect(response.body.stackFrames).toBeDefined();
    });
  });

  describe('scopes', () => {
    it('should return scopes from session', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'scopes',
        seq: 1,
        arguments: { frameId: 1 },
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'scopes') as any;
      expect(response.success).toBe(true);
      expect(response.body.scopes).toBeDefined();
    });
  });

  describe('variables', () => {
    it('should return variables for environment scope', async () => {
      adapter.handleMessage({
        type: 'request',
        command: 'variables',
        seq: 1,
        arguments: { variablesReference: 1 },
      } as any);

      // Wait for async handling
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = sentMessages.find((m: any) => m.command === 'variables') as any;
      expect(response.success).toBe(true);
      expect(response.body.variables).toBeDefined();
    });
  });

  describe('stepping commands', () => {
    it('should handle continue', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'continue',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      expect(mockSession.continue).toHaveBeenCalled();
    });

    it('should handle next (stepOver)', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'next',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      expect(mockSession.stepOver).toHaveBeenCalled();
    });

    it('should handle stepIn', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'stepIn',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      expect(mockSession.stepIn).toHaveBeenCalled();
    });

    it('should handle stepOut', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'stepOut',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      expect(mockSession.stepOut).toHaveBeenCalled();
    });

    it('should handle pause', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'pause',
        seq: 1,
        arguments: { threadId: 1 },
      } as any);

      expect(mockSession.pause).toHaveBeenCalled();
    });
  });

  describe('terminate/disconnect', () => {
    it('should handle disconnect', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'disconnect',
        seq: 1,
        arguments: {},
      } as any);

      expect(mockSession.terminate).toHaveBeenCalled();
    });

    it('should handle terminate', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'terminate',
        seq: 1,
        arguments: {},
      } as any);

      expect(mockSession.terminate).toHaveBeenCalled();
    });
  });

  describe('unknown command', () => {
    it('should return error for unknown command', () => {
      adapter.handleMessage({
        type: 'request',
        command: 'unknownCommand',
        seq: 1,
        arguments: {},
      } as any);

      const response = sentMessages.find((m: any) => m.command === 'unknownCommand') as any;
      expect(response.success).toBe(false);
      expect(response.message).toContain('Unknown command');
    });
  });
});

describe('WorkflowDebugConfigurationProvider', () => {
  let provider: WorkflowDebugConfigurationProvider;

  beforeEach(() => {
    provider = new WorkflowDebugConfigurationProvider();
  });

  describe('resolveDebugConfiguration', () => {
    it('should set defaults', () => {
      const config = provider.resolveDebugConfiguration(
        undefined,
        {
          type: 'generacy',
          request: 'launch',
          name: 'Test',
          workflow: '/test/workflow.yaml',
        }
      );

      expect(config).toBeDefined();
      expect(config?.stopOnEntry).toBe(false);
      expect(config?.dryRun).toBe(false);
    });

    it('should return undefined if no workflow specified', () => {
      const config = provider.resolveDebugConfiguration(
        undefined,
        {
          type: 'generacy',
          request: 'launch',
          name: 'Test',
        }
      );

      expect(config).toBeUndefined();
    });
  });

  describe('provideDebugConfigurations', () => {
    it('should provide default configurations', () => {
      const configs = provider.provideDebugConfigurations(undefined);

      expect(configs).toHaveLength(2);
      expect(configs?.[0]?.name).toContain('Debug');
      expect(configs?.[1]?.name).toContain('Dry Run');
    });
  });
});

describe('WorkflowDebugAdapterFactory', () => {
  let factory: WorkflowDebugAdapterFactory;

  beforeEach(() => {
    factory = new WorkflowDebugAdapterFactory();
  });

  afterEach(() => {
    factory.dispose();
  });

  it('should create debug adapter descriptor', () => {
    const session = { id: 'test-session' } as any;
    const descriptor = factory.createDebugAdapterDescriptor(session, undefined);

    expect(descriptor).toBeDefined();
  });

  it('should return adapter after creation', () => {
    const session = { id: 'test-session' } as any;
    factory.createDebugAdapterDescriptor(session, undefined);

    const adapter = factory.getAdapter();
    expect(adapter).toBeDefined();
  });
});
