/**
 * `/health` — smeeConfigured field.
 *
 * Covers #954: The health response gains an additive optional
 * `smeeConfigured: boolean` field. Absent from response entirely when the
 * option is omitted (harness contract).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupHealthRoutes } from '../health.js';

vi.mock('../../services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => true),
}));

vi.mock('../../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => true),
}));

describe('GET /health — smeeConfigured', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('surfaces smeeConfigured: false when the option is false', async () => {
    server = Fastify();
    await setupHealthRoutes(server, { smeeConfigured: false });
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.smeeConfigured).toBe(false);
  });

  it('surfaces smeeConfigured: true when the option is true', async () => {
    server = Fastify();
    await setupHealthRoutes(server, { smeeConfigured: true });
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.smeeConfigured).toBe(true);
  });

  it('503-path (all checks in error) still validates and includes smeeConfigured', async () => {
    server = Fastify();
    await setupHealthRoutes(server, {
      smeeConfigured: true,
      checks: {
        // Override the default `server: async () => 'ok'` so overall status
        // resolves to `error` and Fastify picks the 503 response schema.
        server: async () => 'error',
      },
    });
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.smeeConfigured).toBe(true);
    expect(body.status).toBe('error');
  });

  it('worker-mode analogue: option is a plain boolean regardless of process role', async () => {
    server = Fastify();
    await setupHealthRoutes(server, { smeeConfigured: false });
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.smeeConfigured).toBe(false);
  });

  it('omitting the option leaves smeeConfigured absent from the response', async () => {
    server = Fastify();
    await setupHealthRoutes(server, {});
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty('smeeConfigured');
  });
});
