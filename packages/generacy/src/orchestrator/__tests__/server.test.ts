/**
 * Integration tests for the orchestrator HTTP server.
 * Tests the full API endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createOrchestratorServer, type OrchestratorServer } from '../server.js';
import type { WorkerRegistration, Heartbeat, JobResult, JobPriority, JobEvent } from '../types.js';

// Mock console.warn to suppress the in-memory queue warning
vi.spyOn(console, 'warn').mockImplementation(() => {});

// Silence logger output during tests
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('OrchestratorServer', () => {
  let server: OrchestratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      port: 0, // Random available port
      host: '127.0.0.1',
      workerTimeout: 5000,
      logger: silentLogger,
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.workers).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    it('should not require authentication', async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/workers/register', () => {
    it('should register a new worker', async () => {
      const registration: WorkerRegistration = {
        id: 'test-worker-1',
        name: 'Test Worker 1',
        capabilities: ['task-a', 'task-b'],
        maxConcurrent: 2,
      };

      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.workerId).toBe('test-worker-1');
    });

    it('should generate worker ID if not provided', async () => {
      const registration: Partial<WorkerRegistration> = {
        name: 'Auto ID Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      };

      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.workerId).toBeDefined();
      expect(typeof data.workerId).toBe('string');
    });

    it('should reject registration without name', async () => {
      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['*'] }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('should reject duplicate worker ID', async () => {
      const registration: WorkerRegistration = {
        id: 'duplicate-worker',
        name: 'Duplicate Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      };

      // First registration
      await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      // Second registration with same ID
      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error.code).toBe('WORKER_ALREADY_EXISTS');
    });
  });

  describe('DELETE /api/workers/:workerId', () => {
    it('should unregister a worker', async () => {
      // First register a worker
      const registration: WorkerRegistration = {
        id: 'worker-to-delete',
        name: 'Worker To Delete',
        capabilities: ['*'],
        maxConcurrent: 1,
      };

      await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      // Then unregister
      const response = await fetch(`${baseUrl}/api/workers/worker-to-delete`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(204);
    });

    it('should return 404 for unknown worker', async () => {
      const response = await fetch(`${baseUrl}/api/workers/unknown-worker-id`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.code).toBe('WORKER_NOT_FOUND');
    });
  });

  describe('POST /api/workers/:workerId/heartbeat', () => {
    let workerId: string;

    beforeEach(async () => {
      // Register a fresh worker for each test
      const registration: WorkerRegistration = {
        id: `heartbeat-worker-${Date.now()}`,
        name: 'Heartbeat Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      };

      const response = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      const data = await response.json();
      workerId = data.workerId;
    });

    it('should acknowledge heartbeat', async () => {
      const heartbeat: Heartbeat = {
        workerId,
        status: 'idle',
        timestamp: new Date().toISOString(),
      };

      const response = await fetch(`${baseUrl}/api/workers/${workerId}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.acknowledged).toBe(true);
    });

    it('should accept heartbeat with current job info', async () => {
      const heartbeat: Heartbeat = {
        workerId,
        status: 'busy',
        currentJob: 'job-123',
        progress: 50,
        timestamp: new Date().toISOString(),
      };

      const response = await fetch(`${baseUrl}/api/workers/${workerId}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.acknowledged).toBe(true);
    });

    it('should return 404 for unknown worker', async () => {
      const heartbeat: Heartbeat = {
        workerId: 'unknown',
        status: 'idle',
        timestamp: new Date().toISOString(),
      };

      const response = await fetch(`${baseUrl}/api/workers/unknown/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat),
      });

      expect(response.status).toBe(404);
    });
  });

  describe('Job API', () => {
    let workerId: string;
    let jobId: string;

    beforeEach(async () => {
      // Register a worker
      const registration: WorkerRegistration = {
        id: `job-worker-${Date.now()}`,
        name: 'Job Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      };

      const registerResponse = await fetch(`${baseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration),
      });

      const registerData = await registerResponse.json();
      workerId = registerData.workerId;

      // Submit a job
      jobId = await server.submitJob({
        name: 'Test Job',
        workflow: 'test.yaml',
        inputs: { param1: 'value1' },
        priority: 'normal' as JobPriority,
      });
    });

    describe('GET /api/jobs/poll', () => {
      it('should return job when available', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.job).toBeDefined();
        expect(data.job.id).toBe(jobId);
        expect(data.job.status).toBe('assigned');
        expect(data.job.workerId).toBe(workerId);
      });

      it('should return null when no jobs available', async () => {
        // First poll gets the job
        await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);

        // Second poll should return null
        const response = await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.job).toBeUndefined();
        expect(data.retryAfter).toBe(5);
      });

      it('should require workerId', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/poll`);
        expect(response.status).toBe(400);

        const data = await response.json();
        expect(data.error.code).toBe('INVALID_REQUEST');
      });

      it('should return 404 for unknown worker', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/poll?workerId=unknown-worker`);
        expect(response.status).toBe(404);

        const data = await response.json();
        expect(data.error.code).toBe('WORKER_NOT_FOUND');
      });

      describe('maxConcurrent enforcement', () => {
        it('should not assign job when worker is at maxConcurrent capacity', async () => {
          // Register a fresh worker with maxConcurrent: 1
          const regResponse = await fetch(`${baseUrl}/api/workers/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `capacity-worker-${Date.now()}`,
              name: 'Capacity Worker',
              capabilities: ['*'],
              maxConcurrent: 1,
            }),
          });
          const { workerId: capWorkerId } = await regResponse.json();

          // Submit 2 jobs
          await server.submitJob({
            name: 'Capacity Job 1',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });
          await server.submitJob({
            name: 'Capacity Job 2',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });

          // First poll gets a job
          const poll1 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${capWorkerId}`);
          const poll1Data = await poll1.json();
          expect(poll1Data.job).toBeDefined();
          expect(poll1Data.job.status).toBe('assigned');
          expect(poll1Data.job.workerId).toBe(capWorkerId);

          // Second poll should return no job — worker is at capacity
          const poll2 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${capWorkerId}`);
          const poll2Data = await poll2.json();
          expect(poll2Data.job).toBeUndefined();
          expect(poll2Data.retryAfter).toBe(5);
        });

        it('should assign next job after first job is completed', async () => {
          // Register a fresh worker with maxConcurrent: 1
          const regResponse = await fetch(`${baseUrl}/api/workers/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `complete-worker-${Date.now()}`,
              name: 'Complete Worker',
              capabilities: ['*'],
              maxConcurrent: 1,
            }),
          });
          const { workerId: compWorkerId } = await regResponse.json();

          // Submit 2 jobs
          await server.submitJob({
            name: 'Complete Job 1',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });
          await server.submitJob({
            name: 'Complete Job 2',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });

          // First poll gets a job
          const poll1 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${compWorkerId}`);
          const poll1Data = await poll1.json();
          expect(poll1Data.job).toBeDefined();
          const firstJobId = poll1Data.job.id;

          // Report result for the first job (completes it and unassigns from worker)
          await fetch(`${baseUrl}/api/jobs/${firstJobId}/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: firstJobId,
              status: 'completed',
              outputs: {},
              duration: 100,
            }),
          });

          // Now poll again — should get another job since worker has capacity
          const poll2 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${compWorkerId}`);
          const poll2Data = await poll2.json();
          expect(poll2Data.job).toBeDefined();
          expect(poll2Data.job.status).toBe('assigned');
          expect(poll2Data.job.workerId).toBe(compWorkerId);
          expect(poll2Data.job.id).not.toBe(firstJobId);
        });

        it('should respect maxConcurrent: 2 allowing two concurrent jobs', async () => {
          // Register a fresh worker with maxConcurrent: 2
          const regResponse = await fetch(`${baseUrl}/api/workers/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `multi-worker-${Date.now()}`,
              name: 'Multi Worker',
              capabilities: ['*'],
              maxConcurrent: 2,
            }),
          });
          const { workerId: multiWorkerId } = await regResponse.json();

          // Submit 3 jobs
          await server.submitJob({
            name: 'Multi Job 1',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });
          await server.submitJob({
            name: 'Multi Job 2',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });
          await server.submitJob({
            name: 'Multi Job 3',
            workflow: 'test.yaml',
            inputs: {},
            priority: 'normal' as JobPriority,
          });

          // First poll gets a job
          const poll1 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${multiWorkerId}`);
          const poll1Data = await poll1.json();
          expect(poll1Data.job).toBeDefined();
          expect(poll1Data.job.status).toBe('assigned');

          // Second poll gets another job (still under maxConcurrent: 2)
          const poll2 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${multiWorkerId}`);
          const poll2Data = await poll2.json();
          expect(poll2Data.job).toBeDefined();
          expect(poll2Data.job.status).toBe('assigned');

          // Third poll should return no job — worker at capacity (2/2)
          const poll3 = await fetch(`${baseUrl}/api/jobs/poll?workerId=${multiWorkerId}`);
          const poll3Data = await poll3.json();
          expect(poll3Data.job).toBeUndefined();
          expect(poll3Data.retryAfter).toBe(5);
        });
      });
    });

    describe('GET /api/jobs/:jobId', () => {
      it('should return job details', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.id).toBe(jobId);
        expect(data.name).toBe('Test Job');
        expect(data.workflow).toBe('test.yaml');
      });

      it('should return 404 for unknown job', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/unknown-job-id`);
        expect(response.status).toBe(404);

        const data = await response.json();
        expect(data.error.code).toBe('JOB_NOT_FOUND');
      });
    });

    describe('PUT /api/jobs/:jobId/status', () => {
      it('should update job status', async () => {
        // First poll the job to assign it
        await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);

        const response = await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'running' }),
        });

        expect(response.status).toBe(204);

        // Verify the status was updated
        const getResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`);
        const data = await getResponse.json();
        expect(data.status).toBe('running');
        expect(data.startedAt).toBeDefined();
      });

      it('should require status field', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error.code).toBe('INVALID_REQUEST');
      });

      it('should return 404 for unknown job', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/unknown-job/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'running' }),
        });

        expect(response.status).toBe(404);
      });
    });

    describe('POST /api/jobs/:jobId/result', () => {
      it('should report job result', async () => {
        // First poll the job to assign it
        await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);

        const result: JobResult = {
          jobId,
          status: 'completed',
          outputs: { result: 'success' },
          duration: 1000,
        };

        const response = await fetch(`${baseUrl}/api/jobs/${jobId}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });

        expect(response.status).toBe(204);

        // Verify the job was updated
        const getResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`);
        const data = await getResponse.json();
        expect(data.status).toBe('completed');
        expect(data.completedAt).toBeDefined();
      });

      it('should require status field', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/${jobId}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        });

        expect(response.status).toBe(400);
      });

      it('should return 404 for unknown job', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/unknown-job/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: 'unknown-job', status: 'completed', duration: 100 }),
        });

        expect(response.status).toBe(404);
      });
    });

    describe('POST /api/jobs/:jobId/cancel', () => {
      it('should cancel a job', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'User requested' }),
        });

        expect(response.status).toBe(204);

        // Verify the job was cancelled
        const getResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`);
        const data = await getResponse.json();
        expect(data.status).toBe('cancelled');
      });

      it('should return 404 for unknown job', async () => {
        const response = await fetch(`${baseUrl}/api/jobs/unknown-job/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(404);
      });
    });
  });

  describe('Not Found Routes', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await fetch(`${baseUrl}/api/unknown`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Authentication', () => {
    let authServer: OrchestratorServer;
    let authBaseUrl: string;

    beforeAll(async () => {
      authServer = createOrchestratorServer({
        port: 0,
        host: '127.0.0.1',
        authToken: 'test-secret-token',
        logger: silentLogger,
      });
      await authServer.listen();
      authBaseUrl = `http://127.0.0.1:${authServer.getPort()}`;
    });

    afterAll(async () => {
      await authServer.close();
    });

    it('should allow health check without auth', async () => {
      const response = await fetch(`${authBaseUrl}/api/health`);
      expect(response.status).toBe(200);
    });

    it('should reject requests without auth token', async () => {
      const response = await fetch(`${authBaseUrl}/api/workers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should reject requests with wrong auth token', async () => {
      const response = await fetch(`${authBaseUrl}/api/workers/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify({ name: 'Test' }),
      });

      expect(response.status).toBe(401);
    });

    it('should accept requests with correct auth token', async () => {
      const response = await fetch(`${authBaseUrl}/api/workers/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret-token',
        },
        body: JSON.stringify({ id: 'auth-worker', name: 'Auth Worker', capabilities: ['*'], maxConcurrent: 1 }),
      });

      expect(response.status).toBe(200);
    });
  });

  describe('submitJob API', () => {
    it('should submit a job and return ID', async () => {
      const jobId = await server.submitJob({
        name: 'Submitted Job',
        workflow: 'submit.yaml',
        inputs: {},
        priority: 'high' as JobPriority,
      });

      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');

      // Verify job exists
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
      const data = await response.json();
      expect(data.name).toBe('Submitted Job');
      expect(data.priority).toBe('high');
      expect(data.status).toBe('pending');
    });

    it('should default priority to normal', async () => {
      const jobId = await server.submitJob({
        name: 'Default Priority Job',
        workflow: 'default.yaml',
        inputs: {},
      });

      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
      const data = await response.json();
      expect(data.priority).toBe('normal');
    });
  });
});

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/**
 * Read SSE events from a streaming fetch response.
 * Returns parsed JobEvent objects. Automatically stops after `timeout` ms
 * or after `maxEvents` events have been collected, or when the stream ends.
 */
async function readSSEEvents(
  response: Response,
  options: { maxEvents?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<JobEvent[]> {
  const { maxEvents = 100, timeout = 3000 } = options;
  const events: JobEvent[] = [];
  const body = response.body;
  if (!body) return events;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const timeoutId = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeout);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE frames (double newline delimited)
      while (buffer.includes('\n\n')) {
        const frameEnd = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        // Parse data field from the frame
        let dataStr = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) {
            dataStr = line.slice(5).trimStart();
          }
        }

        if (dataStr) {
          try {
            events.push(JSON.parse(dataStr) as JobEvent);
          } catch {
            // Skip malformed data
          }
        }
      }
    }
  } catch {
    // Reader cancelled by timeout or abort — that's expected
  } finally {
    clearTimeout(timeoutId);
    reader.releaseLock();
  }

  return events;
}

/**
 * Parse a single SSE frame from raw text.
 */
function parseSSEFrameFields(frame: string): { event?: string; id?: string; data?: string } {
  const result: { event?: string; id?: string; data?: string } = {};
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) result.event = line.slice(6).trimStart();
    else if (line.startsWith('id:')) result.id = line.slice(3).trimStart();
    else if (line.startsWith('data:')) result.data = line.slice(5).trimStart();
  }
  return result;
}

/**
 * Read raw SSE frames (as strings) from a streaming fetch response.
 */
async function readSSEFrames(
  response: Response,
  options: { maxFrames?: number; timeout?: number } = {},
): Promise<string[]> {
  const { maxFrames = 100, timeout = 3000 } = options;
  const frames: string[] = [];
  const body = response.body;
  if (!body) return frames;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const timeoutId = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeout);

  try {
    while (frames.length < maxFrames) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes('\n\n')) {
        const frameEnd = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        // Skip comment-only frames (heartbeats)
        if (!frame.startsWith(':')) {
          frames.push(frame);
        }
      }
    }
  } catch {
    // Reader cancelled
  } finally {
    clearTimeout(timeoutId);
    reader.releaseLock();
  }

  return frames;
}

// ---------------------------------------------------------------------------
// T022: Integration tests for GET /api/jobs/:jobId/events
// ---------------------------------------------------------------------------

describe('GET /api/jobs/:jobId/events (SSE)', () => {
  let server: OrchestratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      port: 0,
      host: '127.0.0.1',
      workerTimeout: 5000,
      sseHeartbeatInterval: 60_000, // Long interval to avoid heartbeat interference
      eventGracePeriod: 60_000,
      logger: silentLogger,
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('should return Content-Type: text/event-stream header', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Header Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');

    controller.abort();
  });

  it('should return 404 for non-existent job', async () => {
    const response = await fetch(`${baseUrl}/api/jobs/nonexistent-job-id/events`);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe('JOB_NOT_FOUND');
  });

  it('should receive events after worker POSTs them', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Events Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    // Give the connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));

    // Worker posts events
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });

    // Read SSE events
    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[0]!.data).toEqual({ phase: 'build' });
    expect(events[1]!.type).toBe('step:start');
    expect(events[1]!.data).toEqual({ step: 'compile' });
  });

  it('should replay buffered events when Last-Event-ID header is provided', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Replay Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Publish some events directly via eventBus (or POST)
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'init' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'setup' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'setup' } }),
    });

    // Subscribe with Last-Event-ID: 1 → should replay events 2 and 3
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      headers: { 'Last-Event-ID': '1' },
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe('2');
    expect(events[0]!.type).toBe('step:start');
    expect(events[1]!.id).toBe('3');
    expect(events[1]!.type).toBe('step:complete');
  });

  it('should auto-close stream when job reaches terminal status via PUT /status', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Terminal Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);

    // Give the connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));

    // Post an event so there's something in the stream
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    // Update status to terminal — this should close the SSE stream
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    // The stream should end (reader should get done=true)
    const events = await readSSEEvents(sseResponse, { maxEvents: 10, timeout: 2000 });

    // We should have received at least the phase:start event + auto-published job:status event
    expect(events.length).toBeGreaterThanOrEqual(1);
    // The stream should have ended (readSSEEvents returns when done=true)
  });

  it('should replay buffered events and close for already-terminal job', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Already Terminal Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Publish some events
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });

    // Set job to terminal status (this also auto-publishes a job:status event)
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    // Now subscribe to the already-terminal job — should get replay then close
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

    // Read all replayed events (stream should close automatically)
    const events = await readSSEEvents(sseResponse, { maxEvents: 20, timeout: 2000 });

    // Should have received the buffered events (phase:start, step:start, job:status)
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.type).toBe('step:start');
  });

  it('should include event: field matching the event type in SSE frames', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Event Field Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Post an event
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:output', data: { output: 'hello' } }),
    });

    // Subscribe with Last-Event-ID: 0 to replay the event
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      headers: { 'Last-Event-ID': '0' },
      signal: controller.signal,
    });

    const frames = await readSSEFrames(sseResponse, { maxFrames: 1, timeout: 2000 });
    controller.abort();

    expect(frames).toHaveLength(1);
    const parsed = parseSSEFrameFields(frames[0]!);
    expect(parsed.event).toBe('step:output');
  });

  it('should include id: field with monotonic counter in SSE frames', async () => {
    const jobId = await server.submitJob({
      name: 'SSE ID Field Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Post multiple events
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'compile' } }),
    });

    // Subscribe with Last-Event-ID: 0 to replay all events
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      headers: { 'Last-Event-ID': '0' },
      signal: controller.signal,
    });

    const frames = await readSSEFrames(sseResponse, { maxFrames: 3, timeout: 2000 });
    controller.abort();

    expect(frames).toHaveLength(3);
    const ids = frames.map((f) => parseSSEFrameFields(f).id);
    expect(ids).toEqual(['1', '2', '3']);
  });

  it('should receive live events after replay when Last-Event-ID is provided', async () => {
    const jobId = await server.submitJob({
      name: 'SSE Replay Then Live Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Pre-publish one event
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    // Subscribe with Last-Event-ID: 0 to replay that event
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      headers: { 'Last-Event-ID': '0' },
      signal: controller.signal,
    });

    // Give connection a moment to establish and receive replay
    await new Promise((r) => setTimeout(r, 50));

    // Now publish a live event
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });

    // Read both replayed and live events
    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    // First: replayed event
    expect(events[0]!.id).toBe('1');
    expect(events[0]!.type).toBe('phase:start');
    // Second: live event
    expect(events[1]!.id).toBe('2');
    expect(events[1]!.type).toBe('step:start');
  });
});

// ---------------------------------------------------------------------------
// T023: Integration tests for GET /api/events (global SSE stream)
// ---------------------------------------------------------------------------

describe('GET /api/events (global SSE)', () => {
  let server: OrchestratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      port: 0,
      host: '127.0.0.1',
      workerTimeout: 5000,
      sseHeartbeatInterval: 60_000, // Long interval to avoid heartbeat interference
      eventGracePeriod: 60_000,
      logger: silentLogger,
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('should return Content-Type: text/event-stream header', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');

    controller.abort();
  });

  it('should return SSE stream with events from multiple jobs', async () => {
    const jobId1 = await server.submitJob({
      name: 'Global SSE Job 1',
      workflow: 'test.yaml',
      inputs: {},
    });
    const jobId2 = await server.submitJob({
      name: 'Global SSE Job 2',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start global SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    // Give the connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));

    // Post events to different jobs
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId2}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events[0]!.jobId).toBe(jobId1);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.jobId).toBe(jobId2);
    expect(events[1]!.type).toBe('step:start');
  });

  it('should filter events by tags query parameter', async () => {
    const jobId1 = await server.submitJob({
      name: 'Tagged Job Deploy',
      workflow: 'deploy.yaml',
      inputs: {},
      tags: ['deploy', 'prod'],
    });
    const jobId2 = await server.submitJob({
      name: 'Tagged Job Build',
      workflow: 'build.yaml',
      inputs: {},
      tags: ['build', 'ci'],
    });

    // Subscribe with tags filter for 'deploy'
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events?tags=deploy`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Post events to both jobs
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'deploy-phase' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId2}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build-phase' } }),
    });

    // Only the deploy job event should come through; wait a bit then post
    // a second deploy event to confirm we can collect at least one
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'push' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    // Both events should be from the deploy job
    expect(events.every((e) => e.jobId === jobId1)).toBe(true);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.type).toBe('step:start');
  });

  it('should filter events by workflow query parameter', async () => {
    const jobId1 = await server.submitJob({
      name: 'Workflow Filter Job 1',
      workflow: 'deploy-flow.yaml',
      inputs: {},
    });
    const jobId2 = await server.submitJob({
      name: 'Workflow Filter Job 2',
      workflow: 'build-flow.yaml',
      inputs: {},
    });

    // Subscribe with workflow filter
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events?workflow=deploy-flow.yaml`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Post events to both jobs
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'deploy' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId2}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    // Post another to the matching job so we can collect it
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'done' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.jobId === jobId1)).toBe(true);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.type).toBe('step:complete');
  });

  it('should filter events by status query parameter', async () => {
    const jobId1 = await server.submitJob({
      name: 'Status Filter Running Job',
      workflow: 'test.yaml',
      inputs: {},
    });
    const jobId2 = await server.submitJob({
      name: 'Status Filter Pending Job',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Move jobId1 to 'running' status
    // First register a worker and poll to get it assigned
    const regResponse = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `status-filter-worker-${Date.now()}`,
        name: 'Status Filter Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      }),
    });
    const { workerId } = await regResponse.json();
    await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);
    await fetch(`${baseUrl}/api/jobs/${jobId1}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });

    // Subscribe with status filter for 'running' only
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events?status=running`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Post events to both jobs
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId2}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'setup' } }),
    });

    // Post another to the running job to get 2 events
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'compile' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.jobId === jobId1)).toBe(true);
  });

  it('should combine multiple filters with AND logic', async () => {
    const jobId1 = await server.submitJob({
      name: 'AND Filter Match',
      workflow: 'deploy.yaml',
      inputs: {},
      tags: ['deploy'],
    });
    const jobId2 = await server.submitJob({
      name: 'AND Filter Tag Only',
      workflow: 'build.yaml',
      inputs: {},
      tags: ['deploy'],
    });
    const jobId3 = await server.submitJob({
      name: 'AND Filter Workflow Only',
      workflow: 'deploy.yaml',
      inputs: {},
      tags: ['test'],
    });

    // Subscribe with both tags and workflow filters — only jobId1 matches both
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events?tags=deploy&workflow=deploy.yaml`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Post events to all three jobs
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'deploy' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId2}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId3}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'test' } }),
    });

    // Post another to the matching job to collect 2 events
    await fetch(`${baseUrl}/api/jobs/${jobId1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'done' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.jobId === jobId1)).toBe(true);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.type).toBe('step:complete');
  });

  it('should receive events from new jobs without reconnection', async () => {
    // Start global SSE subscription before any jobs exist
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Create a new job after the subscription is established
    const jobId = await server.submitJob({
      name: 'Late Arriving Job',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Post events to the newly created job
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'init' } }),
    });
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'setup' } }),
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 2, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(2);
    expect(events[0]!.jobId).toBe(jobId);
    expect(events[0]!.type).toBe('phase:start');
    expect(events[1]!.jobId).toBe(jobId);
    expect(events[1]!.type).toBe('step:start');
  });
});

// ---------------------------------------------------------------------------
// T024: Integration tests for POST /api/jobs/:jobId/events
// ---------------------------------------------------------------------------

describe('POST /api/jobs/:jobId/events', () => {
  let server: OrchestratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      port: 0,
      host: '127.0.0.1',
      workerTimeout: 5000,
      sseHeartbeatInterval: 60_000,
      eventGracePeriod: 60_000,
      logger: silentLogger,
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('should return 201 with { eventId } on success', async () => {
    const jobId = await server.submitJob({
      name: 'Publish Event Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.eventId).toBeDefined();
    expect(typeof data.eventId).toBe('string');
  });

  it('should assign monotonically increasing eventIds', async () => {
    const jobId = await server.submitJob({
      name: 'Monotonic ID Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const res1 = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'init' } }),
    });
    const res2 = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'compile' } }),
    });
    const res3 = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:complete', data: { step: 'compile' } }),
    });

    const data1 = await res1.json();
    const data2 = await res2.json();
    const data3 = await res3.json();

    expect(data1.eventId).toBe('1');
    expect(data2.eventId).toBe('2');
    expect(data3.eventId).toBe('3');
  });

  it('should return 404 for non-existent job', async () => {
    const response = await fetch(`${baseUrl}/api/jobs/nonexistent-job-id/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe('JOB_NOT_FOUND');
  });

  it('should return 400 for missing type field', async () => {
    const jobId = await server.submitJob({
      name: 'Missing Type Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { phase: 'build' } }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 for invalid type field', async () => {
    const jobId = await server.submitJob({
      name: 'Invalid Type Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'not:valid', data: { phase: 'build' } }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 for missing data field', async () => {
    const jobId = await server.submitJob({
      name: 'Missing Data Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start' }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 when data field is not an object', async () => {
    const jobId = await server.submitJob({
      name: 'Non-Object Data Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: 'not-an-object' }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 when data field is an array', async () => {
    const jobId = await server.submitJob({
      name: 'Array Data Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: [1, 2, 3] }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('should make published event appear in an active SSE stream for that job', async () => {
    const jobId = await server.submitJob({
      name: 'Publish And Stream Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    // Give the connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));

    // Publish an event via POST
    const publishResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:output', data: { output: 'hello world' } }),
    });
    expect(publishResponse.status).toBe(201);
    const { eventId } = await publishResponse.json();

    // Read the event from the SSE stream
    const events = await readSSEEvents(sseResponse, { maxEvents: 1, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(eventId);
    expect(events[0]!.type).toBe('step:output');
    expect(events[0]!.data).toEqual({ output: 'hello world' });
    expect(events[0]!.jobId).toBe(jobId);
  });

  it('should accept a custom timestamp in the event body', async () => {
    const jobId = await server.submitJob({
      name: 'Custom Timestamp Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const customTimestamp = 1700000000000;
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' }, timestamp: customTimestamp }),
    });

    // Read back via SSE replay
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      headers: { 'Last-Event-ID': '0' },
      signal: controller.signal,
    });

    const events = await readSSEEvents(sseResponse, { maxEvents: 1, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBe(customTimestamp);
  });

  it('should accept all valid event types', async () => {
    const jobId = await server.submitJob({
      name: 'All Event Types Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    const validTypes = [
      'job:status', 'phase:start', 'phase:complete',
      'step:start', 'step:complete', 'step:output',
      'action:error', 'log:append',
    ];

    for (const type of validTypes) {
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data: { info: type } }),
      });
      expect(response.status).toBe(201);
    }
  });

  describe('with authentication enabled', () => {
    let authServer: OrchestratorServer;
    let authBaseUrl: string;

    beforeAll(async () => {
      authServer = createOrchestratorServer({
        port: 0,
        host: '127.0.0.1',
        authToken: 'test-secret-token',
        sseHeartbeatInterval: 60_000,
        eventGracePeriod: 60_000,
        logger: silentLogger,
      });
      await authServer.listen();
      authBaseUrl = `http://127.0.0.1:${authServer.getPort()}`;
    });

    afterAll(async () => {
      await authServer.close();
    });

    it('should reject POST without auth token', async () => {
      const jobId = await authServer.submitJob({
        name: 'Auth Required Test',
        workflow: 'test.yaml',
        inputs: {},
      });

      const response = await fetch(`${authBaseUrl}/api/jobs/${jobId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should reject POST with wrong auth token', async () => {
      const jobId = await authServer.submitJob({
        name: 'Wrong Token Test',
        workflow: 'test.yaml',
        inputs: {},
      });

      const response = await fetch(`${authBaseUrl}/api/jobs/${jobId}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
      });

      expect(response.status).toBe(401);
    });

    it('should accept POST with correct auth token', async () => {
      const jobId = await authServer.submitJob({
        name: 'Correct Token Test',
        workflow: 'test.yaml',
        inputs: {},
      });

      const response = await fetch(`${authBaseUrl}/api/jobs/${jobId}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret-token',
        },
        body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.eventId).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// T025: Integration tests for auto-publish on status update
// ---------------------------------------------------------------------------

describe('Auto-publish on status update (SSE)', () => {
  let server: OrchestratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = createOrchestratorServer({
      port: 0,
      host: '127.0.0.1',
      workerTimeout: 5000,
      sseHeartbeatInterval: 60_000, // Long interval to avoid heartbeat interference
      eventGracePeriod: 60_000,
      logger: silentLogger,
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('should emit job:status event with { status, previousStatus } when status is updated via PUT', async () => {
    const jobId = await server.submitJob({
      name: 'Auto-publish Status Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    // Give the connection a moment to establish
    await new Promise((r) => setTimeout(r, 50));

    // Update status via PUT — should auto-publish a job:status event
    const putResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(putResponse.status).toBe(204);

    // Read the auto-published SSE event
    const events = await readSSEEvents(sseResponse, { maxEvents: 1, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job:status');
    expect(events[0]!.jobId).toBe(jobId);
    expect(events[0]!.data.status).toBe('running');
    expect(events[0]!.data.previousStatus).toBe('pending');
  });

  it('should emit job:status event with correct previousStatus across multiple transitions', async () => {
    const jobId = await server.submitJob({
      name: 'Multi-transition Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Register a worker and poll to assign the job (pending → assigned)
    const regResponse = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `auto-pub-worker-${Date.now()}`,
        name: 'Auto Publish Worker',
        capabilities: ['*'],
        maxConcurrent: 1,
      }),
    });
    const { workerId } = await regResponse.json();
    await fetch(`${baseUrl}/api/jobs/poll?workerId=${workerId}`);

    // Start SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Transition: assigned → running
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });

    // Read the first event
    const events = await readSSEEvents(sseResponse, { maxEvents: 1, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job:status');
    expect(events[0]!.data.status).toBe('running');
    expect(events[0]!.data.previousStatus).toBe('assigned');
  });

  it('should close per-job SSE stream when terminal status is set via PUT', async () => {
    const jobId = await server.submitJob({
      name: 'Terminal Close Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Set terminal status via PUT
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed' }),
    });

    // The stream should close. readSSEEvents will return when done=true.
    const events = await readSSEEvents(sseResponse, { maxEvents: 10, timeout: 2000 });

    // Should have received the auto-published job:status event before close
    expect(events.length).toBeGreaterThanOrEqual(1);
    const statusEvent = events.find((e) => e.type === 'job:status');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.data.status).toBe('failed');
    expect(statusEvent!.data.previousStatus).toBe('pending');
  });

  it('should close per-job SSE stream when completed status is set via PUT', async () => {
    const jobId = await server.submitJob({
      name: 'Completed Close Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Publish a work event first
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'phase:start', data: { phase: 'build' } }),
    });

    // Now set terminal status
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    // Stream should end — readSSEEvents returns when stream is done
    const events = await readSSEEvents(sseResponse, { maxEvents: 10, timeout: 2000 });

    // Should have both the phase:start and the auto-published job:status event
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.type).toBe('phase:start');

    const statusEvent = events.find((e) => e.type === 'job:status');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.data.status).toBe('completed');
  });

  it('should emit job:status event with cancelled status when job is cancelled via POST /cancel', async () => {
    const jobId = await server.submitJob({
      name: 'Cancel Event Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Cancel the job
    const cancelResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'User requested cancellation' }),
    });
    expect(cancelResponse.status).toBe(204);

    // Read events — stream should close after the cancel event
    const events = await readSSEEvents(sseResponse, { maxEvents: 10, timeout: 2000 });

    expect(events.length).toBeGreaterThanOrEqual(1);
    const statusEvent = events.find((e) => e.type === 'job:status');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.type).toBe('job:status');
    expect(statusEvent!.jobId).toBe(jobId);
    expect(statusEvent!.data.status).toBe('cancelled');
    expect(statusEvent!.data.previousStatus).toBe('pending');
    expect(statusEvent!.data.reason).toBe('User requested cancellation');
  });

  it('should close per-job SSE stream when job is cancelled via POST /cancel', async () => {
    const jobId = await server.submitJob({
      name: 'Cancel Stream Close Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Publish a work event first
    await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'step:start', data: { step: 'setup' } }),
    });

    // Start SSE subscription
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`);
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Cancel the job
    await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Stream should close
    const events = await readSSEEvents(sseResponse, { maxEvents: 10, timeout: 2000 });

    // Should have the cancel event and the stream should be closed
    const statusEvent = events.find((e) => e.type === 'job:status');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.data.status).toBe('cancelled');
  });

  it('should deliver auto-published job:status events to global SSE stream', async () => {
    const jobId = await server.submitJob({
      name: 'Global Auto-publish Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start global SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Update status via PUT
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });

    // Read the auto-published event from the global stream
    const events = await readSSEEvents(sseResponse, { maxEvents: 1, timeout: 2000 });
    controller.abort();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('job:status');
    expect(events[0]!.jobId).toBe(jobId);
    expect(events[0]!.data.status).toBe('running');
    expect(events[0]!.data.previousStatus).toBe('pending');
  });

  it('should include auto-published events in SSE frame format with event: and id: fields', async () => {
    const jobId = await server.submitJob({
      name: 'Auto-publish Frame Format Test',
      workflow: 'test.yaml',
      inputs: {},
    });

    // Start SSE subscription
    const controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(sseResponse.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Trigger auto-publish via PUT
    await fetch(`${baseUrl}/api/jobs/${jobId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });

    // Read raw SSE frames
    const frames = await readSSEFrames(sseResponse, { maxFrames: 1, timeout: 2000 });
    controller.abort();

    expect(frames).toHaveLength(1);
    const parsed = parseSSEFrameFields(frames[0]!);
    expect(parsed.event).toBe('job:status');
    expect(parsed.id).toBeDefined();
    expect(parsed.data).toBeDefined();

    const data = JSON.parse(parsed.data!);
    expect(data.data.status).toBe('running');
    expect(data.data.previousStatus).toBe('pending');
  });
});
