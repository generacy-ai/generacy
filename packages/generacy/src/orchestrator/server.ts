/**
 * Orchestrator HTTP server.
 * Provides REST API for worker registration, job distribution, and health monitoring.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  Job,
  JobStatus,
  JobResult,
  JobEventType,
  WorkerRegistration,
  Heartbeat,
  HeartbeatResponse,
  PollResponse,
  JobPriority,
  EventFilters,
} from './types.js';
import { WorkerRegistry } from './worker-registry.js';
import { InMemoryJobQueue, type JobQueue } from './job-queue.js';
import { createRouter, pathToRegex, parseJsonBody, sendJson, sendError } from './router.js';
import { EventBus } from './event-bus.js';
import { LogBufferManager } from './log-buffer.js';

/**
 * Orchestrator server options
 */
export interface OrchestratorServerOptions {
  /** Port to listen on (default: 3100) */
  port?: number;

  /** Host to bind to (default: '0.0.0.0') */
  host?: string;

  /** Worker heartbeat timeout in milliseconds (default: 60000) */
  workerTimeout?: number;

  /** Job queue instance (defaults to InMemoryJobQueue) */
  jobQueue?: JobQueue;

  /** Authentication token (if not set, auth is disabled) */
  authToken?: string;

  /** SSE event buffer size per job (default: 1000) */
  eventBufferSize?: number;

  /** Grace period in ms before cleaning up terminal job buffers (default: 300000) */
  eventGracePeriod?: number;

  /** SSE heartbeat interval in ms (default: 30000) */
  sseHeartbeatInterval?: number;

  /** Logger instance */
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
}

/**
 * Default logger that writes to console
 */
const defaultLogger = {
  info: (message: string, data?: Record<string, unknown>) => {
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data) : '');
  },
  warn: (message: string, data?: Record<string, unknown>) => {
    console.warn(`[WARN] ${message}`, data ? JSON.stringify(data) : '');
  },
  error: (message: string, data?: Record<string, unknown>) => {
    console.error(`[ERROR] ${message}`, data ? JSON.stringify(data) : '');
  },
};

/**
 * Orchestrator server interface
 */
export interface OrchestratorServer {
  /** Start the server */
  listen(): Promise<void>;

  /** Stop the server */
  close(): Promise<void>;

  /** Get the port the server is listening on */
  getPort(): number;

  /** Submit a job to the queue (for programmatic use) */
  submitJob(job: Omit<Job, 'id' | 'status' | 'createdAt'>): Promise<string>;

  /** Get the underlying HTTP server */
  getHttpServer(): Server;

  /** Get the worker registry */
  getWorkerRegistry(): WorkerRegistry;

  /** Get the job queue */
  getJobQueue(): JobQueue;

  /** Get the event bus */
  getEventBus(): EventBus;
}

/**
 * Create an orchestrator server
 */
export function createOrchestratorServer(options: OrchestratorServerOptions = {}): OrchestratorServer {
  const {
    port = 3100,
    host = '0.0.0.0',
    workerTimeout = 60000,
    authToken = process.env['ORCHESTRATOR_TOKEN'],
    eventBufferSize = 1000,
    eventGracePeriod = 300000,
    sseHeartbeatInterval = 30000,
    logger = defaultLogger,
  } = options;

  // Initialize components
  const workerRegistry = new WorkerRegistry({
    heartbeatTimeout: workerTimeout,
    onWorkerOffline: (workerId) => {
      logger.warn('Worker went offline', { workerId });
    },
    onWorkerUnhealthy: (workerId) => {
      logger.warn('Worker became unhealthy', { workerId });
    },
  });

  const jobQueue = options.jobQueue ?? new InMemoryJobQueue();

  const logBufferManager = new LogBufferManager({
    gracePeriod: eventGracePeriod,
  });

  const eventBus = new EventBus({
    bufferSize: eventBufferSize,
    gracePeriod: eventGracePeriod,
    heartbeatInterval: sseHeartbeatInterval,
    jobQueue,
    logBufferManager,
    logger,
  });

  // Start periodic timeout check
  let timeoutInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Check authentication header
   */
  function authenticate(req: IncomingMessage): boolean {
    if (!authToken) {
      return true; // Auth disabled
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return false;
    }

    return authHeader.slice(7) === authToken;
  }

  /**
   * Build routes using pathToRegex helper
   */
  const healthRoute = pathToRegex('/api/health');
  const registerRoute = pathToRegex('/api/workers/register');
  const unregisterRoute = pathToRegex('/api/workers/:workerId');
  const heartbeatRoute = pathToRegex('/api/workers/:workerId/heartbeat');
  const submitJobRoute = pathToRegex('/api/jobs');
  const pollRoute = pathToRegex('/api/jobs/poll');
  const getJobRoute = pathToRegex('/api/jobs/:jobId');
  const statusRoute = pathToRegex('/api/jobs/:jobId/status');
  const resultRoute = pathToRegex('/api/jobs/:jobId/result');
  const cancelRoute = pathToRegex('/api/jobs/:jobId/cancel');
  const jobEventsRoute = pathToRegex('/api/jobs/:jobId/events');
  const jobLogsRoute = pathToRegex('/api/jobs/:jobId/logs');
  const globalEventsRoute = pathToRegex('/api/events');

  const router = createRouter([
    { method: 'GET', pattern: healthRoute.regex, handler: 'healthCheck', paramNames: healthRoute.paramNames },
    { method: 'POST', pattern: registerRoute.regex, handler: 'registerWorker', paramNames: registerRoute.paramNames },
    { method: 'DELETE', pattern: unregisterRoute.regex, handler: 'unregisterWorker', paramNames: unregisterRoute.paramNames },
    { method: 'POST', pattern: heartbeatRoute.regex, handler: 'handleHeartbeat', paramNames: heartbeatRoute.paramNames },
    { method: 'POST', pattern: submitJobRoute.regex, handler: 'submitJob', paramNames: submitJobRoute.paramNames },
    { method: 'GET', pattern: pollRoute.regex, handler: 'pollJob', paramNames: pollRoute.paramNames },
    { method: 'GET', pattern: globalEventsRoute.regex, handler: 'subscribeAllEvents', paramNames: globalEventsRoute.paramNames },
    { method: 'GET', pattern: jobLogsRoute.regex, handler: 'getJobLogs', paramNames: jobLogsRoute.paramNames },
    { method: 'GET', pattern: jobEventsRoute.regex, handler: 'subscribeJobEvents', paramNames: jobEventsRoute.paramNames },
    { method: 'POST', pattern: jobEventsRoute.regex, handler: 'publishEvent', paramNames: jobEventsRoute.paramNames },
    { method: 'GET', pattern: getJobRoute.regex, handler: 'getJob', paramNames: getJobRoute.paramNames },
    { method: 'PUT', pattern: statusRoute.regex, handler: 'updateJobStatus', paramNames: statusRoute.paramNames },
    { method: 'POST', pattern: resultRoute.regex, handler: 'reportResult', paramNames: resultRoute.paramNames },
    { method: 'POST', pattern: cancelRoute.regex, handler: 'cancelJob', paramNames: cancelRoute.paramNames },
  ]);

  /**
   * Route handlers
   */
  const handlers: Record<string, (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>> = {
    /**
     * GET /api/health - Health check endpoint
     */
    async healthCheck(_req: IncomingMessage, res: ServerResponse) {
      const workerCounts = workerRegistry.getWorkerCounts();
      sendJson(res, 200, {
        status: 'healthy',
        workers: workerCounts.total,
        healthyWorkers: workerCounts.healthy,
        unhealthyWorkers: workerCounts.unhealthy,
        timestamp: new Date().toISOString(),
      });
    },

    /**
     * POST /api/jobs - Submit a new job
     */
    async submitJob(req: IncomingMessage, res: ServerResponse) {
      try {
        const body = await parseJsonBody<Omit<Job, 'id' | 'status' | 'createdAt'>>(req);

        if (!body.name) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: name');
          return;
        }

        if (!body.workflow) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: workflow');
          return;
        }

        const job: Job = {
          ...body,
          id: randomUUID(),
          status: 'pending',
          createdAt: new Date().toISOString(),
          priority: body.priority ?? ('normal' as JobPriority),
          inputs: body.inputs ?? {},
        };

        await jobQueue.enqueue(job);
        logger.info('Job submitted via API', { jobId: job.id, name: job.name });

        sendJson(res, 201, { jobId: job.id, status: job.status });
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error submitting job', { error: String(error) });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to submit job');
        }
      }
    },

    /**
     * POST /api/workers/register - Register a worker
     */
    async registerWorker(req: IncomingMessage, res: ServerResponse) {
      try {
        const body = await parseJsonBody<WorkerRegistration>(req);

        if (!body.name) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: name');
          return;
        }

        // Check if worker ID already exists
        if (body.id && workerRegistry.getWorker(body.id)) {
          sendError(res, 409, 'WORKER_ALREADY_EXISTS', `Worker with ID ${body.id} already exists`);
          return;
        }

        const workerId = await workerRegistry.register(body);
        logger.info('Worker registered', { workerId, name: body.name });

        sendJson(res, 200, { workerId });
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error registering worker', { error: String(error) });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to register worker');
        }
      }
    },

    /**
     * DELETE /api/workers/:workerId - Unregister a worker
     */
    async unregisterWorker(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { workerId } = params;

      if (!workerId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing workerId parameter');
        return;
      }

      const worker = workerRegistry.getWorker(workerId);
      if (!worker) {
        sendError(res, 404, 'WORKER_NOT_FOUND', `Worker with ID ${workerId} not found`);
        return;
      }

      await workerRegistry.unregister(workerId);
      logger.info('Worker unregistered', { workerId });

      res.writeHead(204);
      res.end();
    },

    /**
     * POST /api/workers/:workerId/heartbeat - Handle heartbeat
     */
    async handleHeartbeat(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { workerId } = params;

      if (!workerId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing workerId parameter');
        return;
      }

      try {
        const body = await parseJsonBody<Heartbeat>(req);

        const worker = workerRegistry.getWorker(workerId);
        if (!worker) {
          sendError(res, 404, 'WORKER_NOT_FOUND', `Worker with ID ${workerId} not found`);
          return;
        }

        const response: HeartbeatResponse = await workerRegistry.heartbeat(workerId, {
          ...body,
          workerId,
          timestamp: new Date().toISOString(),
        });

        sendJson(res, 200, response);
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error processing heartbeat', { error: String(error), workerId });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to process heartbeat');
        }
      }
    },

    /**
     * GET /api/jobs/poll - Poll for available jobs
     */
    async pollJob(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const workerId = url.searchParams.get('workerId');
      const capabilitiesParam = url.searchParams.get('capabilities');

      if (!workerId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing required query parameter: workerId');
        return;
      }

      const worker = workerRegistry.getWorker(workerId);
      if (!worker) {
        sendError(res, 404, 'WORKER_NOT_FOUND', `Worker with ID ${workerId} not found`);
        return;
      }

      // Parse capabilities from comma-separated string
      const capabilities = capabilitiesParam ? capabilitiesParam.split(',').map(c => c.trim()) : worker.capabilities;

      const job = await jobQueue.poll(workerId, capabilities);

      if (job) {
        // Assign job to worker in registry
        workerRegistry.assignJob(workerId, job.id);
        logger.info('Job assigned to worker', { jobId: job.id, workerId });
      }

      const response: PollResponse = {
        job: job ?? undefined,
        retryAfter: job ? undefined : 5,
      };

      sendJson(res, 200, response);
    },

    /**
     * GET /api/jobs/:jobId - Get job details
     */
    async getJob(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      const job = await jobQueue.getJob(jobId);
      if (!job) {
        sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
        return;
      }

      sendJson(res, 200, job);
    },

    /**
     * GET /api/jobs/:jobId/events - Subscribe to SSE stream for a single job's events
     */
    async subscribeJobEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      const job = await jobQueue.getJob(jobId);
      if (!job) {
        sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
        return;
      }

      const terminalStates: JobStatus[] = ['completed', 'failed', 'cancelled'];

      // If job is in terminal state, replay buffered events and close
      if (terminalStates.includes(job.status)) {
        const bufferedEvents = eventBus.getBufferedEvents(jobId);
        if (bufferedEvents.length === 0) {
          sendError(res, 404, 'JOB_EVENTS_NOT_FOUND', `No buffered events for terminal job ${jobId}`);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        for (const event of bufferedEvents) {
          res.write(`event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }

      // Set SSE response headers for live stream
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      // Parse Last-Event-ID for reconnection support
      const lastEventId = req.headers['last-event-id'] as string | undefined;

      // Subscribe to the event bus (handles replay and live events)
      eventBus.subscribe(jobId, res, lastEventId);
    },

    /**
     * GET /api/jobs/:jobId/logs - Retrieve buffered log output
     */
    async getJobLogs(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      const url = new URL(req.url!, `http://${req.headers.host}`);
      const sinceParam = url.searchParams.get('since');
      const streamParam = url.searchParams.get('stream');

      const logBuffer = logBufferManager.get(jobId);

      // SSE streaming mode
      if (streamParam === 'true') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        // Send existing entries first
        if (logBuffer) {
          const entries = sinceParam
            ? logBuffer.getAfterId(parseInt(sinceParam, 10))
            : logBuffer.getAll();
          for (const entry of entries) {
            res.write(`event: log:append\nid: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
          }
        }

        // Subscribe to live log events via EventBus
        eventBus.subscribe(jobId, res);
        return;
      }

      // JSON mode: return buffered entries
      if (!logBuffer) {
        sendJson(res, 200, { entries: [], total: 0 });
        return;
      }

      const entries = sinceParam
        ? logBuffer.getAfterId(parseInt(sinceParam, 10))
        : logBuffer.getAll();

      sendJson(res, 200, { entries, total: logBuffer.size });
    },

    /**
     * GET /api/events - Subscribe to SSE stream for all jobs (with optional filters)
     */
    async subscribeAllEvents(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      // Parse filter query parameters
      const tagsParam = url.searchParams.get('tags');
      const workflowParam = url.searchParams.get('workflow');
      const statusParam = url.searchParams.get('status');

      const filters: EventFilters = {};
      if (tagsParam) {
        filters.tags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
      }
      if (workflowParam) {
        filters.workflow = workflowParam;
      }
      if (statusParam) {
        filters.status = statusParam.split(',').map((s) => s.trim()).filter(Boolean) as JobStatus[];
      }

      // Set SSE response headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      // Parse Last-Event-ID for reconnection support
      const lastEventId = req.headers['last-event-id'] as string | undefined;

      // Subscribe to the event bus (handles replay and live events)
      await eventBus.subscribeAll(res, filters, lastEventId);
    },

    /**
     * POST /api/jobs/:jobId/events - Publish an event for a job
     */
    async publishEvent(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      try {
        const job = await jobQueue.getJob(jobId);
        if (!job) {
          sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
          return;
        }

        const body = await parseJsonBody<{ type: string; data: unknown; timestamp?: number }>(req);

        // Validate type field
        const validEventTypes: JobEventType[] = [
          'job:status', 'phase:start', 'phase:complete',
          'step:start', 'step:complete', 'step:output',
          'action:error', 'log:append',
        ];
        if (!body.type || !validEventTypes.includes(body.type as JobEventType)) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing or invalid field: type');
          return;
        }

        // Validate data field
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing or invalid field: data');
          return;
        }

        const publishedEvent = await eventBus.publish(jobId, {
          type: body.type as JobEventType,
          timestamp: body.timestamp ?? Date.now(),
          jobId,
          data: body.data as Record<string, unknown>,
        });

        // Handle terminal status events
        const terminalStatuses: JobStatus[] = ['completed', 'failed', 'cancelled'];
        if (body.type === 'job:status' && terminalStatuses.includes((body.data as Record<string, unknown>).status as JobStatus)) {
          eventBus.closeJobSubscribers(jobId);
          eventBus.scheduleCleanup(jobId);
        }

        sendJson(res, 201, { eventId: publishedEvent.id });
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error publishing event', { error: String(error), jobId });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to publish event');
        }
      }
    },

    /**
     * PUT /api/jobs/:jobId/status - Update job status
     */
    async updateJobStatus(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      try {
        const body = await parseJsonBody<{ status: JobStatus; metadata?: Record<string, unknown> }>(req);

        if (!body.status) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: status');
          return;
        }

        const job = await jobQueue.getJob(jobId);
        if (!job) {
          sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
          return;
        }

        const previousStatus = job.status;
        await jobQueue.updateStatus(jobId, body.status, body.metadata);
        logger.info('Job status updated', { jobId, status: body.status });

        // Auto-publish job:status event
        await eventBus.publish(jobId, {
          type: 'job:status',
          timestamp: Date.now(),
          jobId,
          data: { status: body.status, previousStatus },
        });

        // Handle terminal status
        const terminalStatuses: JobStatus[] = ['completed', 'failed', 'cancelled'];
        if (terminalStatuses.includes(body.status)) {
          eventBus.closeJobSubscribers(jobId);
          eventBus.scheduleCleanup(jobId);
        }

        res.writeHead(204);
        res.end();
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error updating job status', { error: String(error), jobId });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update job status');
        }
      }
    },

    /**
     * POST /api/jobs/:jobId/result - Report job result
     */
    async reportResult(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      try {
        const body = await parseJsonBody<JobResult>(req);

        if (!body.status) {
          sendError(res, 400, 'INVALID_REQUEST', 'Missing required field: status');
          return;
        }

        const job = await jobQueue.getJob(jobId);
        if (!job) {
          sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
          return;
        }

        // Unassign job from worker
        if (job.workerId) {
          workerRegistry.unassignJob(job.workerId, jobId);
        }

        await jobQueue.reportResult(jobId, { ...body, jobId });
        logger.info('Job result reported', { jobId, status: body.status });

        res.writeHead(204);
        res.end();
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error reporting job result', { error: String(error), jobId });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to report job result');
        }
      }
    },

    /**
     * POST /api/jobs/:jobId/cancel - Cancel a job
     */
    async cancelJob(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
      const { jobId } = params;

      if (!jobId) {
        sendError(res, 400, 'INVALID_REQUEST', 'Missing jobId parameter');
        return;
      }

      try {
        const body = await parseJsonBody<{ reason?: string }>(req);

        const job = await jobQueue.getJob(jobId);
        if (!job) {
          sendError(res, 404, 'JOB_NOT_FOUND', `Job with ID ${jobId} not found`);
          return;
        }

        // Unassign job from worker if assigned
        if (job.workerId) {
          workerRegistry.unassignJob(job.workerId, jobId);
        }

        const previousStatus = job.status;
        await jobQueue.cancelJob(jobId, body.reason);
        logger.info('Job cancelled', { jobId, reason: body.reason });

        // Auto-publish job:status event for cancellation
        await eventBus.publish(jobId, {
          type: 'job:status',
          timestamp: Date.now(),
          jobId,
          data: { status: 'cancelled', previousStatus, reason: body.reason },
        });

        eventBus.closeJobSubscribers(jobId);
        eventBus.scheduleCleanup(jobId);

        res.writeHead(204);
        res.end();
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid JSON') {
          sendError(res, 400, 'INVALID_REQUEST', 'Invalid JSON in request body');
        } else {
          logger.error('Error cancelling job', { error: String(error), jobId });
          sendError(res, 500, 'INTERNAL_ERROR', 'Failed to cancel job');
        }
      }
    },
  };

  /**
   * Create HTTP server
   */
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Check authentication for non-health endpoints
    if (path !== '/api/health' && !authenticate(req)) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
      return;
    }

    // Match route
    const match = router(method, path);

    if (!match) {
      sendError(res, 404, 'NOT_FOUND', `Route not found: ${method} ${path}`);
      return;
    }

    // Execute handler
    const handler = handlers[match.handler];
    if (!handler) {
      sendError(res, 500, 'INTERNAL_ERROR', `Handler not found: ${match.handler}`);
      return;
    }

    try {
      await handler(req, res, match.params);
    } catch (error) {
      logger.error('Unhandled error in request handler', { error: String(error), path, method });
      sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }
  });

  let actualPort = port;

  return {
    async listen(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          logger.info('Orchestrator server started', { host, port: actualPort });

          // Start periodic worker timeout check
          timeoutInterval = setInterval(async () => {
            const offlineWorkers = await workerRegistry.checkTimeouts();
            if (offlineWorkers.length > 0) {
              logger.info('Workers went offline due to timeout', { workers: offlineWorkers });
            }
          }, workerTimeout / 2);

          // Start SSE heartbeat
          eventBus.startHeartbeat();

          resolve();
        });
      });
    },

    async close(): Promise<void> {
      if (timeoutInterval) {
        clearInterval(timeoutInterval);
        timeoutInterval = null;
      }

      eventBus.destroy();
      logBufferManager.destroy();

      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            logger.info('Orchestrator server stopped');
            resolve();
          }
        });
      });
    },

    getPort(): number {
      return actualPort;
    },

    async submitJob(jobData: Omit<Job, 'id' | 'status' | 'createdAt'>): Promise<string> {
      const job: Job = {
        ...jobData,
        id: randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        priority: jobData.priority ?? ('normal' as JobPriority),
      };

      await jobQueue.enqueue(job);
      logger.info('Job submitted', { jobId: job.id, name: job.name });

      return job.id;
    },

    getHttpServer(): Server {
      return server;
    },

    getWorkerRegistry(): WorkerRegistry {
      return workerRegistry;
    },

    getJobQueue(): JobQueue {
      return jobQueue;
    },

    getEventBus(): EventBus {
      return eventBus;
    },
  };
}
