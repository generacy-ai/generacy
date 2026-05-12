import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@generacy-ai/control-plane', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/control-plane')>();
  return {
    ...original,
    getCodeServerManager: vi.fn(() => mockManager),
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
import { getCodeServerManager } from '@generacy-ai/control-plane';

let mockManager = {
  start: vi.fn(async () => ({ status: 'starting' as const, socket_path: '/tmp/cs.sock' })),
  stop: vi.fn(async () => {}),
  touch: vi.fn(),
  getStatus: vi.fn(() => 'stopped' as const),
  shutdown: vi.fn(async () => {}),
};

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

  it('includes codeServerReady: false when status is not running', async () => {
    mockManager.getStatus.mockReturnValue('stopped');

    const response = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body);

    expect(body.codeServerReady).toBe(false);
  });

  it('includes codeServerReady: true when status is running', async () => {
    mockManager.getStatus.mockReturnValue('running');

    const response = await server.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body);

    expect(body.codeServerReady).toBe(true);
  });
});
