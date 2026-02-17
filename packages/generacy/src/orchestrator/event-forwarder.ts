/**
 * Event forwarder.
 * Maps WorkflowExecutor events to JobEventType and forwards them
 * to the orchestrator via OrchestratorClient.publishEvent().
 */
import type {
  ExecutionEvent,
  ExecutionEventListener,
  ExecutionEventType,
  Logger,
} from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from './client.js';
import type { JobEventType } from './types.js';

/**
 * Options for creating an event forwarder.
 */
export interface EventForwarderOptions {
  /** Orchestrator client used to publish events */
  client: OrchestratorClient;

  /** Job ID to publish events for */
  jobId: string;

  /** Logger for error reporting */
  logger: Logger;

  /** Total number of phases in the workflow */
  totalPhases: number;

  /** Number of steps in each phase (indexed by phase order) */
  stepsPerPhase: number[];

  /** Callback invoked when progress changes (0-100) */
  onProgress?: (progress: number) => void;
}

/**
 * Result of creating an event forwarder.
 */
export interface EventForwarderResult {
  /** Listener function to attach to WorkflowExecutor.addEventListener() */
  listener: ExecutionEventListener;

  /** Dispose function — logs failure summary and marks forwarder as inactive */
  dispose: () => void;
}

/**
 * Maps each ExecutionEventType (15 types from workflow-engine) to a JobEventType
 * (8 types in orchestrator).
 *
 * Key decisions:
 * - Terminal execution events (complete/error/cancel) map to 'log:append' to avoid
 *   triggering eventBus.closeJobSubscribers() race condition with reportJobResult().
 * - execution:start maps to 'job:status' (safe, no terminal side effects).
 * - phase:error maps to 'phase:complete' — phase completion encompasses both success
 *   and failure; clients distinguish via a 'status' field in the data payload.
 * - step:error maps to 'action:error' for step-level error detail.
 * - action-level events (start/complete/retry) map to 'log:append' as informational entries.
 */
export const EVENT_TYPE_MAP: Record<ExecutionEventType, JobEventType> = {
  'execution:start': 'job:status',
  'execution:complete': 'log:append',
  'execution:error': 'log:append',
  'execution:cancel': 'log:append',
  'phase:start': 'phase:start',
  'phase:complete': 'phase:complete',
  'phase:error': 'phase:complete',
  'step:start': 'step:start',
  'step:complete': 'step:complete',
  'step:error': 'action:error',
  'step:output': 'step:output',
  'action:start': 'log:append',
  'action:complete': 'log:append',
  'action:error': 'action:error',
  'action:retry': 'log:append',
};

/**
 * Check if a value is a plain object (not null, not an array, not a class instance).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip undefined values from an object, returning a clean Record<string, unknown>.
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build the data payload for a forwarded job event from an ExecutionEvent.
 *
 * Includes contextual fields (workflowName, phaseName, stepName, message) when present,
 * duration for :complete events, error details for :error events, and safely spreads
 * any additional data from the original event.
 *
 * For `phase:error` events (mapped to `phase:complete`), a `status: 'error'` field is
 * added so clients can distinguish error completions from successful ones.
 *
 * @param event - The execution event from the workflow engine
 * @param duration - Computed duration in ms for :complete events (optional)
 * @returns A clean record with no undefined values, suitable for JobEvent.data
 */
export function buildPayload(
  event: ExecutionEvent,
  duration?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    workflowName: event.workflowName,
    phaseName: event.phaseName,
    stepName: event.stepName,
    message: event.message,
    duration,
  };

  // For phase:error events mapped to phase:complete, include status and error
  if (event.type === 'phase:error') {
    payload.status = 'error';
    payload.error = isPlainObject(event.data)
      ? event.data.error
      : undefined;
  }

  // For general :error events, extract error from event.data
  if (event.type.endsWith(':error') && event.type !== 'phase:error') {
    payload.error = isPlainObject(event.data)
      ? event.data.error
      : undefined;
  }

  // Safely spread event.data when it's a plain object
  if (isPlainObject(event.data)) {
    const data = event.data;
    // Spread additional data, but don't overwrite explicitly set fields
    for (const [key, value] of Object.entries(data)) {
      if (!(key in payload)) {
        payload[key] = value;
      }
    }
  }

  return stripUndefined(payload);
}

/**
 * Create an event forwarder that subscribes to WorkflowExecutor events,
 * maps them to JobEventType, and forwards them to the orchestrator via
 * OrchestratorClient.publishEvent().
 *
 * The forwarder uses fire-and-forget semantics: publishEvent() rejections
 * are caught and logged (rate-limited to avoid log flooding). Progress is
 * computed from the workflow definition (phases and steps) and reported
 * synchronously via the onProgress callback.
 *
 * @param options - Forwarder configuration
 * @returns An object with a `listener` to attach and a `dispose` to clean up
 */
export function createEventForwarder(options: EventForwarderOptions): EventForwarderResult {
  const { client, jobId, logger, totalPhases, stepsPerPhase, onProgress } = options;

  // --- Duration tracking ---
  const startTimes = new Map<string, number>();

  function trackStart(event: ExecutionEvent): void {
    const key = getDurationKey(event);
    if (key) {
      startTimes.set(key, event.timestamp);
    }
  }

  function computeDuration(event: ExecutionEvent): number | undefined {
    const key = getDurationKey(event);
    if (!key) return undefined;
    const startTime = startTimes.get(key);
    if (startTime === undefined) return undefined;
    startTimes.delete(key);
    return event.timestamp - startTime;
  }

  function getDurationKey(event: ExecutionEvent): string | undefined {
    const { type, phaseName, stepName } = event;
    if (type.startsWith('phase:') && phaseName) {
      return `phase:${phaseName}`;
    }
    if (type.startsWith('step:') && phaseName && stepName) {
      return `step:${phaseName}:${stepName}`;
    }
    if (type.startsWith('action:') && phaseName && stepName) {
      return `action:${phaseName}:${stepName}`;
    }
    return undefined;
  }

  // --- Progress tracking ---
  let completedPhases = 0;
  let completedStepsInCurrentPhase = 0;
  let currentPhaseIndex = -1;
  let lastReportedProgress = -1;

  function updateProgress(event: ExecutionEvent): void {
    const { type } = event;

    if (type === 'phase:start' && event.phaseName) {
      // Find the phase index by matching the next unstarted phase.
      // Phases execute in order, so increment from current position.
      currentPhaseIndex = Math.min(currentPhaseIndex + 1, totalPhases - 1);
      completedStepsInCurrentPhase = 0;
    } else if (type === 'step:complete') {
      completedStepsInCurrentPhase++;
    } else if (type === 'phase:complete' || type === 'phase:error') {
      completedPhases++;
      completedStepsInCurrentPhase = 0;
    } else if (type === 'execution:complete') {
      reportProgress(100);
      return;
    } else {
      // No progress change for other event types
      return;
    }

    // Calculate progress as weighted average of phase/step completion
    let effectiveCompleted = completedPhases;
    if (
      currentPhaseIndex >= 0 &&
      currentPhaseIndex < stepsPerPhase.length &&
      stepsPerPhase[currentPhaseIndex]! > 0 &&
      completedPhases <= currentPhaseIndex // Still in current phase
    ) {
      effectiveCompleted += completedStepsInCurrentPhase / stepsPerPhase[currentPhaseIndex]!;
    }

    const progress = totalPhases > 0
      ? Math.round((effectiveCompleted / totalPhases) * 100)
      : 0;

    reportProgress(Math.min(Math.max(progress, 0), 99)); // Clamp; 100 only on execution:complete
  }

  function reportProgress(progress: number): void {
    if (progress !== lastReportedProgress) {
      lastReportedProgress = progress;
      onProgress?.(progress);
    }
  }

  // --- Error logging (rate-limited) ---
  let failureCount = 0;
  let firstFailureLogged = false;

  function handlePublishError(err: unknown): void {
    failureCount++;
    if (!firstFailureLogged) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Event forwarding failed for job ${jobId}: ${message}`);
      firstFailureLogged = true;
    }
  }

  // --- Listener and dispose ---
  let disposed = false;

  const listener: ExecutionEventListener = (event: ExecutionEvent) => {
    if (disposed) return;

    // Track start timestamps for duration calculation
    if (event.type.endsWith(':start')) {
      trackStart(event);
    }

    // Compute duration for :complete and :error events
    const duration = event.type.endsWith(':complete') || event.type.endsWith(':error')
      ? computeDuration(event)
      : undefined;

    // Map event type and build payload
    const jobEventType = EVENT_TYPE_MAP[event.type];
    const data = buildPayload(event, duration);

    // Fire-and-forget: publish event, catch errors
    client.publishEvent(jobId, {
      type: jobEventType,
      data,
      timestamp: event.timestamp,
    }).catch(handlePublishError);

    // Update progress synchronously (for heartbeat callback)
    updateProgress(event);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    if (failureCount > 0) {
      logger.warn(`Event forwarding: ${failureCount} failure(s) for job ${jobId}`);
    }
  };

  return { listener, dispose };
}
