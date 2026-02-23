/**
 * Tests for event forwarding from WorkflowExecutor to orchestrator.
 *
 * Tests the createEventForwarder() function, EVENT_TYPE_MAP filtering,
 * progress calculation, error handling, and log throttling — all exercised
 * through the JobHandler.executeJob() integration path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobHandler } from '../job-handler.js';
import type { OrchestratorClient } from '../client.js';
import type { Job } from '../types.js';
import type {
  ExecutionEvent,
  ExecutionEventListener,
  ExecutionEventType,
} from '@generacy-ai/workflow-engine';

// ---------------------------------------------------------------------------
// Shared mutable state referenced by the vi.mock factory.
// vi.mock is hoisted, but closures over module-level variables work fine
// as long as the variables are declared with `let`/`var` (not const).
// ---------------------------------------------------------------------------

/** Listeners captured from mocked WorkflowExecutor.addEventListener() */
let capturedListeners: ExecutionEventListener[] = [];

/** Result returned by the mock executor's execute() */
let mockExecuteResult: Record<string, unknown> = {};

/** Callback invoked inside execute() so tests can emit events mid-execution */
let onExecute: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...actual,
    registerWorkflow: vi.fn(),
    resolveRegisteredWorkflow: vi.fn().mockReturnValue(undefined),
    getActionHandlerByType: vi.fn().mockReturnValue(null),

    loadWorkflowFromString: vi.fn().mockImplementation(() => ({
      name: 'test-workflow',
      phases: [
        { name: 'phase-1', steps: [{ name: 'step-1', action: 'mock.action' }] },
        {
          name: 'phase-2',
          steps: [
            { name: 'step-2', action: 'mock.action' },
            { name: 'step-3', action: 'mock.action' },
          ],
        },
      ],
    })),

    prepareWorkflow: vi.fn().mockImplementation((def: any) => ({
      name: def?.name ?? 'test-workflow',
      phases: def?.phases ?? [],
    })),

    WorkflowExecutor: vi.fn().mockImplementation(() => ({
      addEventListener: vi.fn((listener: ExecutionEventListener) => {
        capturedListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      execute: vi.fn(async () => {
        // Let the test emit events during "execution"
        onExecute?.();
        return mockExecuteResult;
      }),
      getExecutionContext: vi.fn(() => null),
      cancel: vi.fn(),
    })),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('main'),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitToListeners(event: ExecutionEvent): void {
  for (const listener of capturedListeners) {
    listener(event);
  }
}

function makeEvent(
  type: ExecutionEventType,
  overrides: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  return {
    type,
    timestamp: Date.now(),
    workflowName: 'test-workflow',
    ...overrides,
  };
}

function createMockClient() {
  return {
    pollForJob: vi.fn(),
    updateJobStatus: vi.fn().mockResolvedValue(undefined),
    reportJobResult: vi.fn().mockResolvedValue(undefined),
    publishEvent: vi.fn().mockResolvedValue({ eventId: 'evt-1' }),
    register: vi.fn(),
    unregister: vi.fn(),
    heartbeat: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    subscribeEvents: vi.fn(),
  } as unknown as OrchestratorClient & {
    publishEvent: ReturnType<typeof vi.fn>;
    reportJobResult: ReturnType<typeof vi.fn>;
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-123',
    name: 'Test Job',
    status: 'queued',
    workflow: 'name: test-workflow\nphases: []',
    inputs: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

/**
 * Drive executeJob() via the polling loop.
 * Returns a promise that resolves once the job completes.
 */
async function executeJobAndWait(
  client: ReturnType<typeof createMockClient>,
  logger: ReturnType<typeof createMockLogger>,
  job: Job,
  opts?: { emitEvents?: () => void },
): Promise<void> {
  let callCount = 0;
  (client as any).pollForJob = vi.fn(async () => {
    callCount++;
    if (callCount === 1) return { job };
    return { job: null };
  });

  // Set the execute-time callback so tests can emit events mid-execution
  onExecute = opts?.emitEvents;

  const handler = new JobHandler({
    client: client as unknown as OrchestratorClient,
    workerId: 'test-worker',
    logger,
    workdir: '/tmp',
  });

  // Wait for the job to complete (reportJobResult is called)
  await new Promise<void>((resolve) => {
    const origReport = client.reportJobResult;
    client.reportJobResult = vi.fn(async (...args: any[]) => {
      await origReport(...args);
      resolve();
    }) as any;

    handler.start();
  });

  handler.stop();

  // Let pending microtasks (forwarder drain) complete
  await new Promise(r => setTimeout(r, 50));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event forwarding', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    capturedListeners = [];
    onExecute = undefined;
    mockExecuteResult = {
      workflowName: 'test-workflow',
      status: 'completed',
      mode: 'normal',
      startTime: Date.now(),
      endTime: Date.now() + 1000,
      duration: 1000,
      phaseResults: [],
      env: {},
    };
    mockClient = createMockClient();
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should forward phase:start events to orchestrator', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
      },
    });

    expect(mockClient.publishEvent).toHaveBeenCalledWith(
      'job-123',
      expect.objectContaining({
        type: 'phase:start',
        data: expect.objectContaining({
          workflowName: 'test-workflow',
          phaseName: 'phase-1',
        }),
      }),
    );
  });

  it('should forward step:complete events with progress', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        // Workflow has 3 total steps (phase-1: 1 step, phase-2: 2 steps)
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-2' }));
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-3' }));
      },
    });

    const publishCalls = mockClient.publishEvent.mock.calls.filter(
      (args) => (args[1] as any).type === 'step:complete',
    );

    expect(publishCalls).toHaveLength(3);
    // 1/3 ≈ 33%, 2/3 ≈ 67%, 3/3 = 100%
    expect(publishCalls[0][1].data.progress).toBe(33);
    expect(publishCalls[1][1].data.progress).toBe(67);
    expect(publishCalls[2][1].data.progress).toBe(100);
  });

  it('should not forward execution:* events', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('execution:start'));
        emitToListeners(makeEvent('execution:complete'));
        emitToListeners(makeEvent('execution:error'));
        emitToListeners(makeEvent('execution:cancel'));
      },
    });

    for (const args of mockClient.publishEvent.mock.calls) {
      expect((args[1] as any).type).not.toMatch(/^execution:/);
    }
  });

  it('should not forward phase:error or step:error', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:error', { phaseName: 'phase-1', message: 'boom' }));
        emitToListeners(makeEvent('step:error', { phaseName: 'phase-1', stepName: 'step-1' }));
      },
    });

    const types = mockClient.publishEvent.mock.calls.map((args) => (args[1] as any).type);
    expect(types).not.toContain('phase:error');
    expect(types).not.toContain('step:error');
  });

  it('should map action:retry to action:error', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('action:retry', {
          phaseName: 'phase-1',
          stepName: 'step-1',
          message: 'retrying...',
        }));
      },
    });

    expect(mockClient.publishEvent).toHaveBeenCalledWith(
      'job-123',
      expect.objectContaining({
        type: 'action:error',
        data: expect.objectContaining({ message: 'retrying...' }),
      }),
    );
  });

  it('should not fail job when event forwarding fails', async () => {
    mockClient.publishEvent = vi.fn().mockRejectedValue(new Error('network error'));

    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
        emitToListeners(makeEvent('step:start', { phaseName: 'phase-1', stepName: 'step-1' }));
      },
    });

    // Job should still complete successfully
    expect(mockClient.reportJobResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-123', status: 'completed' }),
    );
  });

  it('should log first forwarding failure at warn, subsequent at debug', async () => {
    mockClient.publishEvent = vi.fn().mockRejectedValue(new Error('network error'));

    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
        emitToListeners(makeEvent('step:start', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
      },
    });

    // First failure → warn, subsequent → debug
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Event forwarding failed'),
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Event forwarding failed'),
    );
  });

  it('should reset log throttling after a successful publish', async () => {
    // Sequence: fail, fail, succeed, fail — the last fail should log at warn again
    let callIndex = 0;
    mockClient.publishEvent = vi.fn().mockImplementation(() => {
      callIndex++;
      // Calls 1,2 fail; call 3 succeeds; call 4 fails
      if (callIndex <= 2 || callIndex >= 4) {
        return Promise.reject(new Error('network error'));
      }
      return Promise.resolve({ eventId: 'evt-1' });
    });

    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));       // call 1: fail → warn
        emitToListeners(makeEvent('step:start', { phaseName: 'phase-1', stepName: 'step-1' })); // call 2: fail → debug
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' })); // call 3: succeed → resets
        emitToListeners(makeEvent('phase:complete', { phaseName: 'phase-1' }));     // call 4: fail → warn again
      },
    });

    // warn should be called twice: once for the first failure, once after the success reset
    const warnCalls = mockLogger.warn.mock.calls.filter(
      (args) => (args[0] as string).includes('Event forwarding failed'),
    );
    expect(warnCalls).toHaveLength(2);

    // debug should be called once: the second consecutive failure (call 2)
    const debugCalls = mockLogger.debug.mock.calls.filter(
      (args) => (args[0] as string).includes('Event forwarding failed'),
    );
    expect(debugCalls).toHaveLength(1);
  });

  it('should preserve event ordering', async () => {
    // Track the order publishEvent receives events to verify FIFO queue guarantee.
    // All events are emitted synchronously (rapidly) before the first drain()
    // microtask runs, so the queue must process them in emission order.
    const receivedOrder: string[] = [];
    mockClient.publishEvent = vi.fn().mockImplementation((_jobId: string, evt: any) => {
      receivedOrder.push(`${evt.type}:${evt.data?.phaseName ?? ''}:${evt.data?.stepName ?? ''}`);
      return Promise.resolve({ eventId: 'evt-1' });
    });

    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
        emitToListeners(makeEvent('step:start', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('phase:complete', { phaseName: 'phase-1' }));
      },
    });

    // Verify events arrived in the exact emission order
    const types = mockClient.publishEvent.mock.calls.map((args) => (args[1] as any).type);
    expect(types).toEqual(['phase:start', 'step:start', 'step:complete', 'phase:complete']);

    // Also verify the detailed ordering via our tracking array
    expect(receivedOrder).toEqual([
      'phase:start:phase-1:',
      'step:start:phase-1:step-1',
      'step:complete:phase-1:step-1',
      'phase:complete:phase-1:',
    ]);
  });

  it('should calculate progress as completedSteps/totalSteps', async () => {
    // Workflow has 2 phases, 3 total steps (phase-1: 1 step, phase-2: 2 steps)
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        // Step 1 of 3 → 33%
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
        // Step 2 of 3 → 67%
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-2' }));
        // Step 3 of 3 → 100%
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-3' }));
      },
    });

    const stepCalls = mockClient.publishEvent.mock.calls.filter(
      (args) => (args[1] as any).type === 'step:complete',
    );
    expect(stepCalls).toHaveLength(3);
    expect(stepCalls[0][1].data.progress).toBe(33);  // 1/3
    expect(stepCalls[1][1].data.progress).toBe(67);  // 2/3
    expect(stepCalls[2][1].data.progress).toBe(100); // 3/3
  });

  it('should stop forwarding after forwarder.stop()', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
      },
    });

    // At this point the job has completed and forwarder.stop() has been
    // called in the finally block. Record the current call count.
    const callCountAfterStop = mockClient.publishEvent.mock.calls.length;
    expect(callCountAfterStop).toBeGreaterThan(0);

    // Emit more events after the job (and forwarder) have stopped.
    // These use the same captured listeners, but the forwarder should
    // reject any new enqueue() calls because `stopped` is true.
    emitToListeners(makeEvent('phase:start', { phaseName: 'phase-2' }));
    emitToListeners(makeEvent('step:start', { phaseName: 'phase-2', stepName: 'step-2' }));
    emitToListeners(makeEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-2' }));

    // Let any potential microtasks/drains run
    await new Promise(r => setTimeout(r, 50));

    // No additional publishEvent calls should have been made
    expect(mockClient.publishEvent.mock.calls.length).toBe(callCountAfterStop);
  });

  it('should clear queued events when stop is called', async () => {
    // Make publishEvent slow so events pile up in the queue, then stop
    // should discard any remaining queued events.
    let resolvePublish: (() => void) | undefined;
    let publishCallCount = 0;

    mockClient.publishEvent = vi.fn().mockImplementation(() => {
      publishCallCount++;
      if (publishCallCount === 1) {
        // First call blocks until we release it — simulates slow network
        return new Promise<{ eventId: string }>(resolve => {
          resolvePublish = () => resolve({ eventId: 'evt-1' });
        });
      }
      // Subsequent calls resolve immediately (shouldn't be reached if stop works)
      return Promise.resolve({ eventId: `evt-${publishCallCount}` });
    });

    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        // Emit multiple events rapidly. The first starts draining (and blocks),
        // the rest queue up behind it.
        emitToListeners(makeEvent('phase:start', { phaseName: 'phase-1' }));
        emitToListeners(makeEvent('step:start', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('phase:complete', { phaseName: 'phase-1' }));
      },
    });

    // executeJobAndWait has finished — forwarder.stop() has cleared the queue.
    // Now release the blocked first publish call.
    resolvePublish?.();
    await new Promise(r => setTimeout(r, 50));

    // Only the first event should have been published (it was already in-flight
    // when stop was called). The queued events were discarded by stop().
    // The drain loop checks `!stopped` before processing the next item.
    expect(publishCallCount).toBeLessThanOrEqual(2);
  });

  it('should include event data fields in forwarded payload', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('step:output', {
          phaseName: 'phase-1',
          stepName: 'step-1',
          message: 'some output line',
          data: { stdout: 'hello world' },
        }));
      },
    });

    expect(mockClient.publishEvent).toHaveBeenCalledWith(
      'job-123',
      expect.objectContaining({
        type: 'step:output',
        data: expect.objectContaining({
          workflowName: 'test-workflow',
          phaseName: 'phase-1',
          stepName: 'step-1',
          message: 'some output line',
          detail: { stdout: 'hello world' },
        }),
      }),
    );
  });

  it('should not forward action:start or action:complete events', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('action:start', { phaseName: 'phase-1', stepName: 'step-1' }));
        emitToListeners(makeEvent('action:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
      },
    });

    const types = mockClient.publishEvent.mock.calls.map((args) => (args[1] as any).type);
    expect(types).not.toContain('action:start');
    expect(types).not.toContain('action:complete');
  });

  it('should forward action:error events', async () => {
    await executeJobAndWait(mockClient, mockLogger, createMockJob(), {
      emitEvents: () => {
        emitToListeners(makeEvent('action:error', {
          phaseName: 'phase-1',
          stepName: 'step-1',
          message: 'action failed',
        }));
      },
    });

    expect(mockClient.publishEvent).toHaveBeenCalledWith(
      'job-123',
      expect.objectContaining({
        type: 'action:error',
        data: expect.objectContaining({ message: 'action failed' }),
      }),
    );
  });
});
