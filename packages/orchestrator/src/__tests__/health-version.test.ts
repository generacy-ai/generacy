import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

vi.mock('../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => false),
}));

vi.mock('@generacy-ai/control-plane', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/control-plane')>();
  return {
    ...original,
    getCodeServerManager: vi.fn(() => null),
  };
});

vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...original,
    createGitHubClient: vi.fn(() => ({})),
  };
});

import type { FastifyInstance } from 'fastify';

const prevEnv = process.env.ORCHESTRATOR_VERSION;

async function bootServer(): Promise<FastifyInstance> {
  vi.resetModules();
  const { createServer } = await import('../server.js');
  const { createTestConfig } = await import('../config/index.js');
  const config = createTestConfig({
    server: { port: 0, host: '127.0.0.1' },
    redis: { url: 'redis://127.0.0.1:1' },
  });
  return createServer({ config });
}

describe('GET /health — version field (FR-007)', () => {
  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ORCHESTRATOR_VERSION;
    } else {
      process.env.ORCHESTRATOR_VERSION = prevEnv;
    }
    vi.doUnmock('../services/orchestrator-version.js');
  });

  it('(a) uses ORCHESTRATOR_VERSION when it is a real value', async () => {
    process.env.ORCHESTRATOR_VERSION = 'sha-abc1234';
    const server = await bootServer();
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.body);
      expect(body.version).toBe('sha-abc1234');
    } finally {
      await server.close();
    }
  });

  it('(b) env var "0.0.0" falls through to package.json', async () => {
    process.env.ORCHESTRATOR_VERSION = '0.0.0';
    const server = await bootServer();
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.body);
      expect(body.version).not.toBe('0.0.0');
      expect(body.version).not.toBe('');
    } finally {
      await server.close();
    }
  });

  it('(c) emits "unknown" sentinel when resolver returns "unknown"', async () => {
    delete process.env.ORCHESTRATOR_VERSION;
    vi.doMock('../services/orchestrator-version.js', () => ({
      resolveOrchestratorVersion: () => 'unknown',
    }));
    const server = await bootServer();
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.body);
      expect(body.version).toBe('unknown');
    } finally {
      await server.close();
    }
  });
});
