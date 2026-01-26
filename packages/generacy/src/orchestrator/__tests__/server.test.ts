/**
 * Integration tests for the orchestrator HTTP server.
 * Tests the full API endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createOrchestratorServer, type OrchestratorServer } from '../server.js';
import type { WorkerRegistration, Heartbeat, JobResult, JobPriority } from '../types.js';

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
