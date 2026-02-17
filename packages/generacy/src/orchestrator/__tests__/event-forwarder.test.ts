/**
 * Unit tests for EventForwarder — event type mapping and data payload construction.
 *
 * Verifies all 15 ExecutionEventType values map to the correct JobEventType
 * through the EVENT_TYPE_MAP constant and through the createEventForwarder listener.
 * Also verifies that buildPayload() constructs correct data payloads including
 * contextual fields, event.data spreading, error handling, and undefined stripping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionEvent, ExecutionEventType, Logger } from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from '../client.js';
import type { JobEventType } from '../types.js';
import { EVENT_TYPE_MAP, buildPayload, createEventForwarder } from '../event-forwarder.js';

// --- Helpers ---

function createMockClient(): OrchestratorClient {
  return {
    publishEvent: vi.fn().mockResolvedValue({ eventId: 'evt-1' }),
  } as unknown as OrchestratorClient;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createEvent(
  type: ExecutionEventType,
  overrides: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  return {
    type,
    timestamp: Date.now(),
    workflowName: 'test-workflow',
    phaseName: undefined,
    stepName: undefined,
    message: undefined,
    data: undefined,
    ...overrides,
  };
}

// --- Tests ---

describe('EVENT_TYPE_MAP', () => {
  it('should contain exactly 15 entries (one for each ExecutionEventType)', () => {
    expect(Object.keys(EVENT_TYPE_MAP)).toHaveLength(15);
  });

  describe('execution-level mappings', () => {
    it('should map execution:start to job:status', () => {
      expect(EVENT_TYPE_MAP['execution:start']).toBe('job:status');
    });

    it('should map execution:complete to log:append (avoids terminal side effects)', () => {
      expect(EVENT_TYPE_MAP['execution:complete']).toBe('log:append');
    });

    it('should map execution:error to log:append (avoids terminal side effects)', () => {
      expect(EVENT_TYPE_MAP['execution:error']).toBe('log:append');
    });

    it('should map execution:cancel to log:append (avoids terminal side effects)', () => {
      expect(EVENT_TYPE_MAP['execution:cancel']).toBe('log:append');
    });
  });

  describe('phase-level mappings', () => {
    it('should map phase:start to phase:start (direct)', () => {
      expect(EVENT_TYPE_MAP['phase:start']).toBe('phase:start');
    });

    it('should map phase:complete to phase:complete (direct)', () => {
      expect(EVENT_TYPE_MAP['phase:complete']).toBe('phase:complete');
    });

    it('should map phase:error to phase:complete (error completion)', () => {
      expect(EVENT_TYPE_MAP['phase:error']).toBe('phase:complete');
    });
  });

  describe('step-level mappings', () => {
    it('should map step:start to step:start (direct)', () => {
      expect(EVENT_TYPE_MAP['step:start']).toBe('step:start');
    });

    it('should map step:complete to step:complete (direct)', () => {
      expect(EVENT_TYPE_MAP['step:complete']).toBe('step:complete');
    });

    it('should map step:error to action:error', () => {
      expect(EVENT_TYPE_MAP['step:error']).toBe('action:error');
    });

    it('should map step:output to step:output (direct)', () => {
      expect(EVENT_TYPE_MAP['step:output']).toBe('step:output');
    });
  });

  describe('action-level mappings', () => {
    it('should map action:start to log:append', () => {
      expect(EVENT_TYPE_MAP['action:start']).toBe('log:append');
    });

    it('should map action:complete to log:append', () => {
      expect(EVENT_TYPE_MAP['action:complete']).toBe('log:append');
    });

    it('should map action:error to action:error (direct)', () => {
      expect(EVENT_TYPE_MAP['action:error']).toBe('action:error');
    });

    it('should map action:retry to log:append', () => {
      expect(EVENT_TYPE_MAP['action:retry']).toBe('log:append');
    });
  });
});

describe('createEventForwarder — event type mapping via listener', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  /**
   * Table-driven test: for each ExecutionEventType, verify the listener
   * calls publishEvent with the correctly mapped JobEventType.
   */
  const mappingCases: Array<{
    executionType: ExecutionEventType;
    expectedJobType: JobEventType;
    eventOverrides?: Partial<ExecutionEvent>;
  }> = [
    { executionType: 'execution:start', expectedJobType: 'job:status' },
    { executionType: 'execution:complete', expectedJobType: 'log:append' },
    { executionType: 'execution:error', expectedJobType: 'log:append' },
    { executionType: 'execution:cancel', expectedJobType: 'log:append' },
    {
      executionType: 'phase:start',
      expectedJobType: 'phase:start',
      eventOverrides: { phaseName: 'phase-1' },
    },
    {
      executionType: 'phase:complete',
      expectedJobType: 'phase:complete',
      eventOverrides: { phaseName: 'phase-1' },
    },
    {
      executionType: 'phase:error',
      expectedJobType: 'phase:complete',
      eventOverrides: { phaseName: 'phase-1', data: { error: 'phase failed' } },
    },
    {
      executionType: 'step:start',
      expectedJobType: 'step:start',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1' },
    },
    {
      executionType: 'step:complete',
      expectedJobType: 'step:complete',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1' },
    },
    {
      executionType: 'step:error',
      expectedJobType: 'action:error',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1', data: { error: 'step failed' } },
    },
    {
      executionType: 'step:output',
      expectedJobType: 'step:output',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1' },
    },
    {
      executionType: 'action:start',
      expectedJobType: 'log:append',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1' },
    },
    {
      executionType: 'action:complete',
      expectedJobType: 'log:append',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1' },
    },
    {
      executionType: 'action:error',
      expectedJobType: 'action:error',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1', data: { error: 'action failed' } },
    },
    {
      executionType: 'action:retry',
      expectedJobType: 'log:append',
      eventOverrides: { phaseName: 'phase-1', stepName: 'step-1', message: 'retrying attempt 2' },
    },
  ];

  it.each(mappingCases)(
    'should forward $executionType as $expectedJobType',
    ({ executionType, expectedJobType, eventOverrides }) => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [2, 3],
      });

      const event = createEvent(executionType, eventOverrides);
      listener(event);

      expect(client.publishEvent).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ type: expectedJobType }),
      );
    },
  );

  it('should pass the event timestamp to publishEvent', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    const timestamp = 1700000000000;
    const event = createEvent('execution:start', { timestamp });
    listener(event);

    expect(client.publishEvent).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ timestamp }),
    );
  });

  it('should forward all 15 event types without errors', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    // Emit all 15 event types — none should throw
    for (const { executionType, eventOverrides } of mappingCases) {
      const event = createEvent(executionType, eventOverrides);
      expect(() => listener(event)).not.toThrow();
    }

    expect(client.publishEvent).toHaveBeenCalledTimes(15);
  });

  it('should use the correct jobId for all forwarded events', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'my-job-42',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start'));
    listener(createEvent('phase:start', { phaseName: 'p1' }));
    listener(createEvent('step:start', { phaseName: 'p1', stepName: 's1' }));

    const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
    for (const [jobId] of calls) {
      expect(jobId).toBe('my-job-42');
    }
  });
});

// --- T010: Data payload construction ---

describe('buildPayload — data payload construction', () => {
  describe('contextual fields', () => {
    it('should include workflowName when present', () => {
      const event = createEvent('execution:start', { workflowName: 'my-workflow' });
      const payload = buildPayload(event);
      expect(payload.workflowName).toBe('my-workflow');
    });

    it('should include phaseName when present', () => {
      const event = createEvent('phase:start', { phaseName: 'setup-phase' });
      const payload = buildPayload(event);
      expect(payload.phaseName).toBe('setup-phase');
    });

    it('should include stepName when present', () => {
      const event = createEvent('step:start', {
        phaseName: 'p1',
        stepName: 'install-deps',
      });
      const payload = buildPayload(event);
      expect(payload.stepName).toBe('install-deps');
    });

    it('should include message when present', () => {
      const event = createEvent('action:retry', {
        phaseName: 'p1',
        stepName: 's1',
        message: 'retrying attempt 3',
      });
      const payload = buildPayload(event);
      expect(payload.message).toBe('retrying attempt 3');
    });

    it('should include all contextual fields together', () => {
      const event = createEvent('step:start', {
        workflowName: 'wf-1',
        phaseName: 'phase-a',
        stepName: 'step-b',
        message: 'starting step',
      });
      const payload = buildPayload(event);
      expect(payload).toEqual(expect.objectContaining({
        workflowName: 'wf-1',
        phaseName: 'phase-a',
        stepName: 'step-b',
        message: 'starting step',
      }));
    });

    it('should omit phaseName, stepName, message when they are undefined', () => {
      const event = createEvent('execution:start', {
        workflowName: 'wf-1',
        phaseName: undefined,
        stepName: undefined,
        message: undefined,
      });
      const payload = buildPayload(event);
      expect(payload).toHaveProperty('workflowName');
      expect(payload).not.toHaveProperty('phaseName');
      expect(payload).not.toHaveProperty('stepName');
      expect(payload).not.toHaveProperty('message');
    });
  });

  describe('duration inclusion', () => {
    it('should include duration when provided', () => {
      const event = createEvent('phase:complete', { phaseName: 'p1' });
      const payload = buildPayload(event, 1500);
      expect(payload.duration).toBe(1500);
    });

    it('should not include duration when undefined', () => {
      const event = createEvent('phase:start', { phaseName: 'p1' });
      const payload = buildPayload(event);
      expect(payload).not.toHaveProperty('duration');
    });

    it('should include duration of 0', () => {
      const event = createEvent('step:complete', {
        phaseName: 'p1',
        stepName: 's1',
      });
      const payload = buildPayload(event, 0);
      expect(payload.duration).toBe(0);
    });
  });

  describe('event.data spreading', () => {
    it('should spread event.data when it is a plain object', () => {
      const event = createEvent('step:output', {
        phaseName: 'p1',
        stepName: 's1',
        data: { output: 'hello world', exitCode: 0 },
      });
      const payload = buildPayload(event);
      expect(payload.output).toBe('hello world');
      expect(payload.exitCode).toBe(0);
    });

    it('should not overwrite explicitly set fields when spreading event.data', () => {
      const event = createEvent('step:start', {
        phaseName: 'p1',
        stepName: 's1',
        data: { workflowName: 'overridden', phaseName: 'overridden', customField: 'kept' },
      });
      const payload = buildPayload(event);
      // Explicit fields should NOT be overwritten
      expect(payload.workflowName).toBe('test-workflow');
      expect(payload.phaseName).toBe('p1');
      // Additional fields from data should be included
      expect(payload.customField).toBe('kept');
    });

    it('should not spread event.data when it is undefined', () => {
      const event = createEvent('execution:start', { data: undefined });
      const payload = buildPayload(event);
      // Should only contain workflowName (other fields are undefined and stripped)
      expect(Object.keys(payload)).toEqual(['workflowName']);
    });

    it('should not spread event.data when it is null', () => {
      const event = createEvent('execution:start', { data: null as unknown });
      const payload = buildPayload(event);
      expect(Object.keys(payload)).toEqual(['workflowName']);
    });

    it('should not spread event.data when it is an array', () => {
      const event = createEvent('execution:start', {
        data: ['item1', 'item2'] as unknown,
      });
      const payload = buildPayload(event);
      expect(Object.keys(payload)).toEqual(['workflowName']);
    });

    it('should not spread event.data when it is a primitive string', () => {
      const event = createEvent('execution:start', {
        data: 'some string' as unknown,
      });
      const payload = buildPayload(event);
      expect(Object.keys(payload)).toEqual(['workflowName']);
    });

    it('should not spread event.data when it is a primitive number', () => {
      const event = createEvent('execution:start', {
        data: 42 as unknown,
      });
      const payload = buildPayload(event);
      expect(Object.keys(payload)).toEqual(['workflowName']);
    });
  });

  describe('phase:error events', () => {
    it('should include status: "error" for phase:error events', () => {
      const event = createEvent('phase:error', {
        phaseName: 'setup',
        data: { error: 'phase failed' },
      });
      const payload = buildPayload(event);
      expect(payload.status).toBe('error');
    });

    it('should include error field extracted from event.data for phase:error', () => {
      const event = createEvent('phase:error', {
        phaseName: 'setup',
        data: { error: 'connection timeout' },
      });
      const payload = buildPayload(event);
      expect(payload.error).toBe('connection timeout');
    });

    it('should handle phase:error when event.data has no error field', () => {
      const event = createEvent('phase:error', {
        phaseName: 'setup',
        data: { otherField: 'value' },
      });
      const payload = buildPayload(event);
      expect(payload.status).toBe('error');
      // error is undefined and should be stripped
      expect(payload).not.toHaveProperty('error');
      // otherField should be spread
      expect(payload.otherField).toBe('value');
    });

    it('should handle phase:error when event.data is undefined', () => {
      const event = createEvent('phase:error', {
        phaseName: 'setup',
        data: undefined,
      });
      const payload = buildPayload(event);
      expect(payload.status).toBe('error');
      expect(payload).not.toHaveProperty('error');
    });
  });

  describe('general :error events', () => {
    it('should extract error from event.data for step:error', () => {
      const event = createEvent('step:error', {
        phaseName: 'p1',
        stepName: 's1',
        data: { error: 'step failed' },
      });
      const payload = buildPayload(event);
      expect(payload.error).toBe('step failed');
    });

    it('should extract error from event.data for action:error', () => {
      const event = createEvent('action:error', {
        phaseName: 'p1',
        stepName: 's1',
        data: { error: 'action timed out' },
      });
      const payload = buildPayload(event);
      expect(payload.error).toBe('action timed out');
    });

    it('should extract error from event.data for execution:error', () => {
      const event = createEvent('execution:error', {
        data: { error: 'execution crashed' },
      });
      const payload = buildPayload(event);
      expect(payload.error).toBe('execution crashed');
    });

    it('should not include error for non-error events', () => {
      const event = createEvent('step:complete', {
        phaseName: 'p1',
        stepName: 's1',
        data: { result: 'ok' },
      });
      const payload = buildPayload(event);
      expect(payload).not.toHaveProperty('error');
      expect(payload.result).toBe('ok');
    });

    it('should not add status: "error" for non-phase:error error events', () => {
      const event = createEvent('step:error', {
        phaseName: 'p1',
        stepName: 's1',
        data: { error: 'fail' },
      });
      const payload = buildPayload(event);
      expect(payload).not.toHaveProperty('status');
    });
  });

  describe('undefined value stripping', () => {
    it('should strip all undefined values from the payload', () => {
      const event = createEvent('execution:start', {
        workflowName: 'wf',
        phaseName: undefined,
        stepName: undefined,
        message: undefined,
        data: undefined,
      });
      const payload = buildPayload(event);
      const values = Object.values(payload);
      expect(values).not.toContain(undefined);
    });

    it('should preserve falsy but defined values (empty string, 0, false)', () => {
      const event = createEvent('step:output', {
        phaseName: 'p1',
        stepName: 's1',
        message: '',
        data: { count: 0, enabled: false, name: '' },
      });
      const payload = buildPayload(event);
      expect(payload.message).toBe('');
      expect(payload.count).toBe(0);
      expect(payload.enabled).toBe(false);
      expect(payload.name).toBe('');
    });

    it('should preserve null values in spread data (not strip them)', () => {
      const event = createEvent('step:output', {
        phaseName: 'p1',
        stepName: 's1',
        data: { result: null },
      });
      const payload = buildPayload(event);
      expect(payload.result).toBeNull();
    });
  });
});

describe('createEventForwarder — data payload via listener', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  it('should forward contextual fields through publishEvent data', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('step:start', {
      workflowName: 'wf-1',
      phaseName: 'phase-a',
      stepName: 'step-b',
      message: 'starting step',
    }));

    const call = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const data = call[1].data;
    expect(data.workflowName).toBe('wf-1');
    expect(data.phaseName).toBe('phase-a');
    expect(data.stepName).toBe('step-b');
    expect(data.message).toBe('starting step');
  });

  it('should spread event.data fields through publishEvent data', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('step:output', {
      phaseName: 'p1',
      stepName: 's1',
      data: { output: 'build output', exitCode: 0 },
    }));

    const call = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const data = call[1].data;
    expect(data.output).toBe('build output');
    expect(data.exitCode).toBe(0);
  });

  it('should include status: "error" in data for phase:error events', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('phase:error', {
      phaseName: 'setup',
      data: { error: 'phase failed' },
    }));

    const call = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const data = call[1].data;
    expect(data.status).toBe('error');
    expect(data.error).toBe('phase failed');
  });

  it('should not include undefined values in forwarded data', () => {
    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start', {
      workflowName: 'wf',
      phaseName: undefined,
      stepName: undefined,
      message: undefined,
    }));

    const call = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const data = call[1].data;
    expect(Object.values(data)).not.toContain(undefined);
  });
});

// --- T011: Duration calculation ---

describe('createEventForwarder — duration calculation', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  describe('phase duration', () => {
    it('should compute duration for phase:complete from phase:start timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('phase:start', {
        phaseName: 'setup',
        timestamp: 1000,
      }));

      listener(createEvent('phase:complete', {
        phaseName: 'setup',
        timestamp: 3500,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'phase:complete',
      );
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data.duration).toBe(2500);
    });

    it('should compute duration for phase:error from phase:start timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('phase:start', {
        phaseName: 'build',
        timestamp: 5000,
      }));

      listener(createEvent('phase:error', {
        phaseName: 'build',
        timestamp: 7200,
        data: { error: 'build failed' },
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      // phase:error maps to phase:complete
      const errorCall = calls.find(
        (c: unknown[]) =>
          (c[1] as { type: string }).type === 'phase:complete' &&
          (c[1] as { data: Record<string, unknown> }).data.status === 'error',
      );
      expect(errorCall).toBeDefined();
      expect((errorCall![1] as { data: Record<string, unknown> }).data.duration).toBe(2200);
    });
  });

  describe('step duration', () => {
    it('should compute duration for step:complete from step:start timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [2],
      });

      listener(createEvent('step:start', {
        phaseName: 'build',
        stepName: 'compile',
        timestamp: 2000,
      }));

      listener(createEvent('step:complete', {
        phaseName: 'build',
        stepName: 'compile',
        timestamp: 5000,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'step:complete',
      );
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data.duration).toBe(3000);
    });

    it('should compute duration for step:error from step:start timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('step:start', {
        phaseName: 'test',
        stepName: 'unit-tests',
        timestamp: 10000,
      }));

      listener(createEvent('step:error', {
        phaseName: 'test',
        stepName: 'unit-tests',
        timestamp: 12500,
        data: { error: 'test failed' },
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      // step:error maps to action:error
      const errorCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'action:error',
      );
      expect(errorCall).toBeDefined();
      expect((errorCall![1] as { data: Record<string, unknown> }).data.duration).toBe(2500);
    });
  });

  describe('action duration', () => {
    it('should compute duration for action:complete from action:start timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('action:start', {
        phaseName: 'deploy',
        stepName: 'upload',
        timestamp: 8000,
      }));

      listener(createEvent('action:complete', {
        phaseName: 'deploy',
        stepName: 'upload',
        timestamp: 9500,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      // Both action:start and action:complete map to log:append
      const completeCalls = calls.filter(
        (c: unknown[]) => (c[1] as { type: string }).type === 'log:append',
      );
      // Second log:append call is the action:complete
      const completeCall = completeCalls[1];
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data.duration).toBe(1500);
    });
  });

  describe('missing start event', () => {
    it('should not include duration for phase:complete without prior phase:start', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      // Emit phase:complete without a preceding phase:start
      listener(createEvent('phase:complete', {
        phaseName: 'orphan-phase',
        timestamp: 5000,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'phase:complete',
      );
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('duration');
    });

    it('should not include duration for step:complete without prior step:start', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      // Emit step:complete without a preceding step:start
      listener(createEvent('step:complete', {
        phaseName: 'build',
        stepName: 'compile',
        timestamp: 3000,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'step:complete',
      );
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('duration');
    });

    it('should not include duration for action:complete without prior action:start', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('action:complete', {
        phaseName: 'deploy',
        stepName: 'upload',
        timestamp: 4000,
      }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      // action:complete maps to log:append
      const logCall = calls[0];
      expect(logCall).toBeDefined();
      expect((logCall![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('duration');
    });
  });

  describe('duration isolation', () => {
    it('should track separate durations for different phases', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [1, 1],
      });

      listener(createEvent('phase:start', { phaseName: 'phase-a', timestamp: 1000 }));
      listener(createEvent('phase:complete', { phaseName: 'phase-a', timestamp: 3000 }));
      listener(createEvent('phase:start', { phaseName: 'phase-b', timestamp: 3500 }));
      listener(createEvent('phase:complete', { phaseName: 'phase-b', timestamp: 8000 }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCalls = calls.filter(
        (c: unknown[]) => (c[1] as { type: string }).type === 'phase:complete',
      );

      expect(completeCalls).toHaveLength(2);
      expect((completeCalls[0]![1] as { data: Record<string, unknown> }).data.duration).toBe(2000);
      expect((completeCalls[1]![1] as { data: Record<string, unknown> }).data.duration).toBe(4500);
    });

    it('should track separate durations for different steps within a phase', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [2],
      });

      listener(createEvent('step:start', { phaseName: 'build', stepName: 'lint', timestamp: 1000 }));
      listener(createEvent('step:complete', { phaseName: 'build', stepName: 'lint', timestamp: 2000 }));
      listener(createEvent('step:start', { phaseName: 'build', stepName: 'compile', timestamp: 2500 }));
      listener(createEvent('step:complete', { phaseName: 'build', stepName: 'compile', timestamp: 6000 }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCalls = calls.filter(
        (c: unknown[]) => (c[1] as { type: string }).type === 'step:complete',
      );

      expect(completeCalls).toHaveLength(2);
      expect((completeCalls[0]![1] as { data: Record<string, unknown> }).data.duration).toBe(1000);
      expect((completeCalls[1]![1] as { data: Record<string, unknown> }).data.duration).toBe(3500);
    });

    it('should not include duration for non-complete/non-error events', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('phase:start', { phaseName: 'build', timestamp: 1000 }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const startCall = calls[0];
      expect(startCall).toBeDefined();
      expect((startCall![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('duration');
    });

    it('should consume start timestamp on complete (no reuse)', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [1, 1],
      });

      listener(createEvent('phase:start', { phaseName: 'setup', timestamp: 1000 }));
      listener(createEvent('phase:complete', { phaseName: 'setup', timestamp: 3000 }));
      // Second complete for same phase without a new start
      listener(createEvent('phase:complete', { phaseName: 'setup', timestamp: 5000 }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCalls = calls.filter(
        (c: unknown[]) => (c[1] as { type: string }).type === 'phase:complete',
      );

      expect(completeCalls).toHaveLength(2);
      // First complete should have duration
      expect((completeCalls[0]![1] as { data: Record<string, unknown> }).data.duration).toBe(2000);
      // Second complete should NOT have duration (start was consumed)
      expect((completeCalls[1]![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('duration');
    });

    it('should compute duration as 0 when start and complete have the same timestamp', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
      });

      listener(createEvent('phase:start', { phaseName: 'fast', timestamp: 5000 }));
      listener(createEvent('phase:complete', { phaseName: 'fast', timestamp: 5000 }));

      const calls = (client.publishEvent as ReturnType<typeof vi.fn>).mock.calls;
      const completeCall = calls.find(
        (c: unknown[]) => (c[1] as { type: string }).type === 'phase:complete',
      );
      expect(completeCall).toBeDefined();
      expect((completeCall![1] as { data: Record<string, unknown> }).data.duration).toBe(0);
    });
  });
});

// --- T012: Progress calculation ---

describe('createEventForwarder — progress calculation', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  describe('2-phase workflow (phase 1: 2 steps, phase 2: 3 steps)', () => {
    it('should report progress as steps and phases complete', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [2, 3],
        onProgress,
      });

      // Phase 1 starts (currentPhaseIndex=0, 0 steps done)
      // effectiveCompleted = 0 + 0/2 = 0, progress = round(0/2 * 100) = 0
      listener(createEvent('phase:start', { phaseName: 'phase-1' }));
      expect(onProgress).toHaveBeenLastCalledWith(0);

      // Phase 1, step 1 completes (1/2 steps in phase 1)
      // effectiveCompleted = 0 + 1/2 = 0.5, progress = round(0.5/2 * 100) = 25
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
      expect(onProgress).toHaveBeenLastCalledWith(25);

      // Phase 1, step 2 completes (2/2 steps in phase 1)
      // effectiveCompleted = 0 + 2/2 = 1.0, progress = round(1.0/2 * 100) = 50
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-2' }));
      expect(onProgress).toHaveBeenLastCalledWith(50);

      // Phase 1 completes (completedPhases=1)
      // effectiveCompleted = 1, progress = round(1/2 * 100) = 50
      listener(createEvent('phase:complete', { phaseName: 'phase-1' }));
      // Progress stays 50 (same value — no new call since it's identical)
      expect(onProgress).toHaveBeenLastCalledWith(50);
    });

    it('should report progress through phase 2', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [2, 3],
        onProgress,
      });

      // Complete phase 1 fully
      listener(createEvent('phase:start', { phaseName: 'phase-1' }));
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-1' }));
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 'step-2' }));
      listener(createEvent('phase:complete', { phaseName: 'phase-1' }));

      // Phase 2 starts (currentPhaseIndex=1, completedPhases=1)
      // effectiveCompleted = 1 + 0/3 = 1, progress = round(1/2 * 100) = 50
      // Note: progress is 50 (same as last reported from step:complete above), so
      // onProgress is NOT called again (deduplication). Verify via step completion.
      listener(createEvent('phase:start', { phaseName: 'phase-2' }));

      // Phase 2, step 1 completes (1/3 steps in phase 2)
      // effectiveCompleted = 1 + 1/3 ≈ 1.333, progress = round(1.333/2 * 100) = 67
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-a' }));
      expect(onProgress).toHaveBeenLastCalledWith(67);

      // Phase 2, step 2 completes (2/3 steps in phase 2)
      // effectiveCompleted = 1 + 2/3 ≈ 1.667, progress = round(1.667/2 * 100) = 83
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-b' }));
      expect(onProgress).toHaveBeenLastCalledWith(83);

      // Phase 2, step 3 completes (3/3 steps in phase 2)
      // effectiveCompleted = 1 + 3/3 = 2.0, progress = round(2.0/2 * 100) = 100
      // But clamped to 99 (100 only on execution:complete)
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'step-c' }));
      expect(onProgress).toHaveBeenLastCalledWith(99);

      // Phase 2 completes (completedPhases=2)
      // effectiveCompleted = 2, progress = round(2/2 * 100) = 100, clamped to 99
      // Same value (99), so onProgress not called again
      listener(createEvent('phase:complete', { phaseName: 'phase-2' }));
      expect(onProgress).toHaveBeenLastCalledWith(99);
    });

    it('should report exactly 100 on execution:complete', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [2, 3],
        onProgress,
      });

      // Complete full workflow
      listener(createEvent('phase:start', { phaseName: 'phase-1' }));
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 's1' }));
      listener(createEvent('step:complete', { phaseName: 'phase-1', stepName: 's2' }));
      listener(createEvent('phase:complete', { phaseName: 'phase-1' }));
      listener(createEvent('phase:start', { phaseName: 'phase-2' }));
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'sa' }));
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'sb' }));
      listener(createEvent('step:complete', { phaseName: 'phase-2', stepName: 'sc' }));
      listener(createEvent('phase:complete', { phaseName: 'phase-2' }));

      onProgress.mockClear();

      // execution:complete forces progress to 100
      listener(createEvent('execution:complete'));
      expect(onProgress).toHaveBeenCalledWith(100);
      expect(onProgress).toHaveBeenCalledTimes(1);
    });
  });

  describe('progress clamping', () => {
    it('should clamp progress to 0 minimum', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 0, // Edge case: no phases
        stepsPerPhase: [],
        onProgress,
      });

      listener(createEvent('phase:start', { phaseName: 'phantom' }));
      // With totalPhases=0, formula yields 0; clamped to 0
      expect(onProgress).toHaveBeenCalledWith(0);
    });

    it('should never exceed 99 before execution:complete', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
        onProgress,
      });

      listener(createEvent('phase:start', { phaseName: 'only-phase' }));
      listener(createEvent('step:complete', { phaseName: 'only-phase', stepName: 's1' }));
      // effectiveCompleted = 0 + 1/1 = 1, progress = round(1/1 * 100) = 100 → clamped to 99
      listener(createEvent('phase:complete', { phaseName: 'only-phase' }));

      // All calls before execution:complete should be ≤ 99
      for (const call of onProgress.mock.calls) {
        expect(call[0]).toBeLessThanOrEqual(99);
      }
    });

    it('should allow exactly 100 only on execution:complete', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
        onProgress,
      });

      listener(createEvent('phase:start', { phaseName: 'only' }));
      listener(createEvent('step:complete', { phaseName: 'only', stepName: 's1' }));
      listener(createEvent('phase:complete', { phaseName: 'only' }));
      listener(createEvent('execution:complete'));

      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall![0]).toBe(100);
    });
  });

  describe('deduplication', () => {
    it('should not call onProgress when progress value has not changed', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [2, 3],
        onProgress,
      });

      // phase:start → progress 0
      listener(createEvent('phase:start', { phaseName: 'p1' }));
      const callCountAfterStart = onProgress.mock.calls.length;

      // step:complete → progress 25 (new value, should call)
      listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's1' }));
      expect(onProgress.mock.calls.length).toBe(callCountAfterStart + 1);

      // step:complete → progress 50 (new value, should call)
      listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's2' }));
      const callCountBefore = onProgress.mock.calls.length;

      // phase:complete → completedPhases=1, effectiveCompleted=1, progress=round(1/2*100)=50
      // Same as previous (50), should NOT call
      listener(createEvent('phase:complete', { phaseName: 'p1' }));
      expect(onProgress.mock.calls.length).toBe(callCountBefore);
    });
  });

  describe('events that do not affect progress', () => {
    it('should not call onProgress for non-progress events', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [2],
        onProgress,
      });

      // These event types do not affect progress
      listener(createEvent('execution:start'));
      listener(createEvent('step:start', { phaseName: 'p1', stepName: 's1' }));
      listener(createEvent('step:output', { phaseName: 'p1', stepName: 's1', data: { output: 'hi' } }));
      listener(createEvent('action:start', { phaseName: 'p1', stepName: 's1' }));
      listener(createEvent('action:complete', { phaseName: 'p1', stepName: 's1' }));
      listener(createEvent('action:retry', { phaseName: 'p1', stepName: 's1' }));
      listener(createEvent('action:error', { phaseName: 'p1', stepName: 's1', data: { error: 'fail' } }));

      expect(onProgress).not.toHaveBeenCalled();
    });
  });

  describe('phase:error advances progress like phase:complete', () => {
    it('should increment completedPhases on phase:error', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 2,
        stepsPerPhase: [1, 1],
        onProgress,
      });

      listener(createEvent('phase:start', { phaseName: 'p1' }));
      // phase:error should count as phase completion for progress
      listener(createEvent('phase:error', { phaseName: 'p1', data: { error: 'fail' } }));

      // completedPhases=1, progress = round(1/2 * 100) = 50
      expect(onProgress).toHaveBeenLastCalledWith(50);
    });
  });

  describe('onProgress not provided', () => {
    it('should not throw when onProgress is not provided', () => {
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [1],
        // no onProgress callback
      });

      // Should not throw
      expect(() => {
        listener(createEvent('phase:start', { phaseName: 'p1' }));
        listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's1' }));
        listener(createEvent('phase:complete', { phaseName: 'p1' }));
        listener(createEvent('execution:complete'));
      }).not.toThrow();
    });
  });

  describe('single-phase workflow', () => {
    it('should report correct progress for a single phase with 3 steps', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 1,
        stepsPerPhase: [3],
        onProgress,
      });

      listener(createEvent('phase:start', { phaseName: 'only' }));
      expect(onProgress).toHaveBeenLastCalledWith(0);

      // 1/3 steps: effectiveCompleted = 0 + 1/3 ≈ 0.333, progress = round(0.333/1*100) = 33
      listener(createEvent('step:complete', { phaseName: 'only', stepName: 's1' }));
      expect(onProgress).toHaveBeenLastCalledWith(33);

      // 2/3 steps: effectiveCompleted = 0 + 2/3 ≈ 0.667, progress = round(0.667/1*100) = 67
      listener(createEvent('step:complete', { phaseName: 'only', stepName: 's2' }));
      expect(onProgress).toHaveBeenLastCalledWith(67);

      // 3/3 steps: effectiveCompleted = 0 + 3/3 = 1.0, progress = round(1.0/1*100) = 100 → clamped to 99
      listener(createEvent('step:complete', { phaseName: 'only', stepName: 's3' }));
      expect(onProgress).toHaveBeenLastCalledWith(99);

      listener(createEvent('phase:complete', { phaseName: 'only' }));
      // completedPhases=1, effectiveCompleted=1, round(1/1*100)=100 → clamped to 99
      expect(onProgress).toHaveBeenLastCalledWith(99);

      listener(createEvent('execution:complete'));
      expect(onProgress).toHaveBeenLastCalledWith(100);
    });
  });

  describe('execution:complete without prior events', () => {
    it('should force progress to 100 even with no prior progress events', () => {
      const onProgress = vi.fn();
      const { listener } = createEventForwarder({
        client,
        jobId: 'job-1',
        logger,
        totalPhases: 3,
        stepsPerPhase: [2, 2, 2],
        onProgress,
      });

      // Jump directly to execution:complete (e.g., workflow was very fast or skipped)
      listener(createEvent('execution:complete'));
      expect(onProgress).toHaveBeenCalledWith(100);
      expect(onProgress).toHaveBeenCalledTimes(1);
    });
  });
});

// --- T013: Fire-and-forget error handling ---

/**
 * Helper: flush microtask queue so .catch() handlers run.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createEventForwarder — fire-and-forget error handling', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  it('should not propagate publishEvent rejection to the listener caller', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network error'),
    );

    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    // Listener must not throw synchronously
    expect(() => listener(createEvent('execution:start'))).not.toThrow();

    // Flush the microtask queue so .catch() runs
    await flushPromises();

    // If we get here without an unhandled rejection, fire-and-forget works
    expect(client.publishEvent).toHaveBeenCalledTimes(1);
  });

  it('should call logger.warn on the first failure', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );

    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start'));
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    );
  });

  it('should include the jobId in the warning message', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );

    const { listener } = createEventForwarder({
      client,
      jobId: 'my-special-job',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start'));
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('my-special-job'),
    );
  });

  it('should call logger.warn only once for 10 consecutive failures (rate-limited)', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('server unavailable'),
    );

    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [5],
    });

    // Emit 10 events that all fail
    for (let i = 0; i < 10; i++) {
      listener(createEvent('step:start', {
        phaseName: 'p1',
        stepName: `step-${i}`,
      }));
    }

    await flushPromises();

    // logger.warn should be called exactly once (first failure only)
    expect(client.publishEvent).toHaveBeenCalledTimes(10);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('should log a summary warning with failure count on dispose()', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );

    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [3],
    });

    // Emit 5 events that all fail
    for (let i = 0; i < 5; i++) {
      listener(createEvent('action:start', {
        phaseName: 'p1',
        stepName: `s${i}`,
      }));
    }

    await flushPromises();

    // Reset to distinguish dispose log from the first-failure log
    const warnCallsBefore = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;

    dispose();

    // dispose() should log a summary with the failure count
    expect(logger.warn).toHaveBeenCalledTimes(warnCallsBefore + 1);
    const disposeCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[warnCallsBefore];
    expect(disposeCall![0]).toContain('5');
    expect(disposeCall![0]).toContain('job-1');
  });

  it('should handle non-Error rejection values gracefully', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      'string error message',
    );

    const { listener } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start'));
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('string error message'),
    );
  });

  it('should not log a summary on dispose() when there are no failures', () => {
    // Default mock resolves successfully
    const { dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    dispose();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// --- T014: Dispose and cleanup ---

describe('createEventForwarder — dispose and cleanup', () => {
  let client: OrchestratorClient;
  let logger: Logger;

  beforeEach(() => {
    client = createMockClient();
    logger = createMockLogger();
  });

  it('should not call publishEvent for events emitted after dispose()', () => {
    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [2],
    });

    // Emit one event before dispose — should be forwarded
    listener(createEvent('execution:start'));
    expect(client.publishEvent).toHaveBeenCalledTimes(1);

    dispose();

    // Emit several events after dispose — none should be forwarded
    listener(createEvent('phase:start', { phaseName: 'p1' }));
    listener(createEvent('step:start', { phaseName: 'p1', stepName: 's1' }));
    listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's1' }));
    listener(createEvent('phase:complete', { phaseName: 'p1' }));
    listener(createEvent('execution:complete'));

    // publishEvent should still only have been called once (before dispose)
    expect(client.publishEvent).toHaveBeenCalledTimes(1);
  });

  it('should not call onProgress for events emitted after dispose()', () => {
    const onProgress = vi.fn();
    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [2],
      onProgress,
    });

    // Emit a progress-affecting event before dispose
    listener(createEvent('phase:start', { phaseName: 'p1' }));
    expect(onProgress).toHaveBeenCalledTimes(1);

    dispose();
    onProgress.mockClear();

    // Emit progress-affecting events after dispose — onProgress should not be called
    listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's1' }));
    listener(createEvent('phase:complete', { phaseName: 'p1' }));
    listener(createEvent('execution:complete'));

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('should log failure summary on dispose() when failures occurred', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network error'),
    );

    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-42',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    // Emit 3 events that all fail
    listener(createEvent('execution:start'));
    listener(createEvent('phase:start', { phaseName: 'p1' }));
    listener(createEvent('step:start', { phaseName: 'p1', stepName: 's1' }));

    await flushPromises();

    // Clear the first-failure log to isolate the dispose log
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();

    dispose();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('3'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('job-42'),
    );
  });

  it('should not log on dispose() when no failures occurred', () => {
    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    // Emit events that succeed (default mock resolves)
    listener(createEvent('execution:start'));
    listener(createEvent('phase:start', { phaseName: 'p1' }));

    dispose();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should be idempotent — calling dispose() twice should not log twice', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );

    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    listener(createEvent('execution:start'));
    await flushPromises();

    // Clear the first-failure log
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();

    dispose();
    dispose(); // Second call should be a no-op

    // Only one summary log, not two
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('should not forward events even after dispose() is called twice', () => {
    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [1],
    });

    dispose();
    dispose();

    listener(createEvent('execution:start'));
    listener(createEvent('phase:start', { phaseName: 'p1' }));

    expect(client.publishEvent).not.toHaveBeenCalled();
  });

  it('should stop accumulating failure count after dispose()', async () => {
    (client.publishEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );

    const { listener, dispose } = createEventForwarder({
      client,
      jobId: 'job-1',
      logger,
      totalPhases: 1,
      stepsPerPhase: [3],
    });

    // Emit 2 events that fail
    listener(createEvent('execution:start'));
    listener(createEvent('phase:start', { phaseName: 'p1' }));
    await flushPromises();

    dispose();

    // Emit more events after dispose — these should not trigger publishEvent
    // so the failure count should not increase
    listener(createEvent('step:start', { phaseName: 'p1', stepName: 's1' }));
    listener(createEvent('step:complete', { phaseName: 'p1', stepName: 's1' }));

    // publishEvent should only have been called for the 2 events before dispose
    expect(client.publishEvent).toHaveBeenCalledTimes(2);

    // The summary logged by dispose should mention 2 failures, not more
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const summaryCall = warnCalls.find(
      (c: unknown[]) => (c[0] as string).includes('failure(s)'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain('2');
  });
});
