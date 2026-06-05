import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer } from '../../../src/server.js';
import { setupHealthRoutes } from '../../../src/routes/health.js';
import { GitHubAuthHealthService } from '../../../src/services/github-auth-health.js';
import { GitHubAuthSnapshotSchema } from '../../../src/types/github-auth.js';
import type { FastifyInstance } from 'fastify';

describe('Health Routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
    await setupHealthRoutes(server, {
      checks: {
        database: async () => 'ok',
        redis: async () => 'ok',
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('should return 200 when all services are healthy', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.services).toBeDefined();
      expect(body.services.server).toBe('ok');
      expect(body.services.database).toBe('ok');
      expect(body.services.redis).toBe('ok');
    });
  });

  describe('GET /health/live', () => {
    it('should return 200 for liveness check', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when ready', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });
  });
});

describe('Health Routes with failing services', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
    await setupHealthRoutes(server, {
      checks: {
        database: async () => 'ok',
        redis: async () => 'error',
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('should return 200 with degraded status when some services fail', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('degraded');
      expect(body.services.database).toBe('ok');
      expect(body.services.redis).toBe('error');
    });
  });

  describe('GET /health/ready', () => {
    it('should return 503 when services fail', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);

      const body = JSON.parse(response.payload);
      expect(body.status).toBe('not ready');
    });
  });
});

describe('Health Routes /health.githubAuth (#762)', () => {
  function newService() {
    return new GitHubAuthHealthService({
      emitEvent: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
  }

  async function makeServer(getter: () => ReturnType<GitHubAuthHealthService['snapshot']> | undefined) {
    const s = await createTestServer();
    await setupHealthRoutes(s, { githubAuth: getter });
    await s.ready();
    return s;
  }

  it('renders unknown snapshot conformant to contract', async () => {
    const svc = newService();
    const s = await makeServer(() => svc.snapshot());
    const response = await s.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.payload);
    expect(body.githubAuth).toEqual({ status: 'unknown', consecutiveFailures: 0 });
    expect(GitHubAuthSnapshotSchema.safeParse(body.githubAuth).success).toBe(true);
    await s.close();
  });

  it('renders ok snapshot conformant to contract', async () => {
    const svc = newService();
    svc.setCredentials([{ credentialId: 'primary', type: 'github-app' }]);
    svc.recordResult('primary', { ok: true });
    const s = await makeServer(() => svc.snapshot());
    const response = await s.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.payload);
    expect(body.githubAuth.status).toBe('ok');
    expect(body.githubAuth.credentialId).toBe('primary');
    expect(GitHubAuthSnapshotSchema.safeParse(body.githubAuth).success).toBe(true);
    await s.close();
  });

  it('renders failing snapshot conformant to contract', async () => {
    const svc = newService();
    svc.setCredentials([{ credentialId: 'primary', type: 'github-app' }]);
    svc.recordResult('primary', { ok: false, statusCode: 401 });
    const s = await makeServer(() => svc.snapshot());
    const response = await s.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.payload);
    expect(body.githubAuth.status).toBe('failing');
    expect(body.githubAuth.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(GitHubAuthSnapshotSchema.safeParse(body.githubAuth).success).toBe(true);
    await s.close();
  });

  it('omits githubAuth field when no getter configured', async () => {
    const s = await createTestServer();
    await setupHealthRoutes(s, {});
    await s.ready();
    const response = await s.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.payload);
    expect(body.githubAuth).toBeUndefined();
    await s.close();
  });
});
