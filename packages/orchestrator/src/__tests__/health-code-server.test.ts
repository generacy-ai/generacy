import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
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
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import { probeCodeServerSocket } from '../services/code-server-probe.js';

const mockProbe = vi.mocked(probeCodeServerSocket);

describe('GET /health — codeServerReady', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const config = createTestConfig({
      server: { port: 0, host: '127.0.0.1' },
      redis: { url: 'redis://127.0.0.1:1' },
    });
    server = await createServer(config);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('includes codeServerReady: false when probe returns false', async () => {
    mockProbe.mockResolvedValue(false);

    const response = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body);

    expect(body.codeServerReady).toBe(false);
  });

  it('includes codeServerReady: true when probe returns true', async () => {
    mockProbe.mockResolvedValue(true);

    const response = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body);

    expect(body.codeServerReady).toBe(true);
  });
});
