import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorClient } from '../orchestrator/client.js';
import type { HttpClient, HttpResponse, HttpRequestOptions } from '../orchestrator/http.js';

function stubHttp(
  responses: Record<string, HttpResponse<unknown> | Error>,
): { client: HttpClient; calls: Array<{ url: string; options?: HttpRequestOptions }> } {
  const calls: Array<{ url: string; options?: HttpRequestOptions }> = [];
  const client: HttpClient = {
    get: vi.fn(async <T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> => {
      calls.push({ url, options });
      for (const [pattern, value] of Object.entries(responses)) {
        if (url.endsWith(pattern)) {
          if (value instanceof Error) throw value;
          return value as HttpResponse<T>;
        }
      }
      throw new Error(`unexpected url: ${url}`);
    }),
  };
  return { client, calls };
}

describe('createOrchestratorClient', () => {
  describe('stub mode (a)', () => {
    it('returns stub when token is undefined', async () => {
      const client = createOrchestratorClient({});
      expect(client.isAvailable()).toBe(false);
      const h = await client.health();
      const j = await client.getJobs();
      const w = await client.getWorkers();
      expect(h).toEqual({ available: false, reason: 'no-token' });
      expect(j).toEqual({ available: false, reason: 'no-token' });
      expect(w).toEqual({ available: false, reason: 'no-token' });
    });

    it('returns stub when token is empty string', async () => {
      const client = createOrchestratorClient({ token: '' });
      expect(client.isAvailable()).toBe(false);
    });

    it('returns stub when token is whitespace', async () => {
      const client = createOrchestratorClient({ token: '   ' });
      expect(client.isAvailable()).toBe(false);
    });

    it('stub never invokes the http client', async () => {
      const { client: http, calls } = stubHttp({});
      const client = createOrchestratorClient({ httpClient: http });
      await client.health();
      await client.getJobs();
      await client.getWorkers();
      expect(calls).toHaveLength(0);
    });
  });

  describe('live mode (b)', () => {
    it('health 200 → { available: true, status: ok, data }', async () => {
      const { client: http } = stubHttp({
        '/health': { status: 200, data: { status: 'ok', uptime: 12 } },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        baseUrl: 'http://orch.test',
        httpClient: http,
      });
      expect(client.isAvailable()).toBe(true);
      const result = await client.health();
      expect(result).toEqual({
        available: true,
        status: 'ok',
        data: { status: 'ok', uptime: 12 },
      });
    });

    it('health 200 degraded → status: degraded', async () => {
      const { client: http } = stubHttp({
        '/health': { status: 200, data: { status: 'degraded', reason: 'lag' } },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.health();
      expect(result).toMatchObject({ available: true, status: 'degraded' });
    });

    it('getJobs 200 returns parsed JobSummary array', async () => {
      const { client: http } = stubHttp({
        '/queue': {
          status: 200,
          data: {
            jobs: [
              { id: 'j1', status: 'running', workflowId: 'w1' },
              { id: 'j2', status: 'pending' },
              { id: null, status: 'bogus' },
            ],
          },
        },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.getJobs();
      if (!result.available) throw new Error('expected available');
      expect(result.jobs).toEqual([
        { id: 'j1', status: 'running', workflowId: 'w1' },
        { id: 'j2', status: 'pending' },
      ]);
    });

    it('getWorkers 200 returns parsed WorkerSummary array', async () => {
      const { client: http } = stubHttp({
        '/dispatch/queue/workers': {
          status: 200,
          data: {
            workers: [
              { id: 'w1', status: 'idle' },
              { id: 'w2', status: 'busy', currentJobId: 'j1' },
            ],
          },
        },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.getWorkers();
      if (!result.available) throw new Error('expected available');
      expect(result.workers).toEqual([
        { id: 'w1', status: 'idle' },
        { id: 'w2', status: 'busy', currentJobId: 'j1' },
      ]);
    });

    it('attaches Authorization: Bearer header', async () => {
      const { client: http, calls } = stubHttp({
        '/health': { status: 200, data: { status: 'ok' } },
      });
      const client = createOrchestratorClient({
        token: 'secret',
        httpClient: http,
      });
      await client.health();
      expect(calls[0]?.options?.headers?.['Authorization']).toBe('Bearer secret');
    });

    it('uses default baseUrl when not provided', async () => {
      const { client: http, calls } = stubHttp({
        '/health': { status: 200, data: { status: 'ok' } },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      await client.health();
      expect(calls[0]?.url).toBe('http://127.0.0.1:3100/health');
    });

    it('strips trailing slash from baseUrl', async () => {
      const { client: http, calls } = stubHttp({
        '/health': { status: 200, data: { status: 'ok' } },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        baseUrl: 'http://orch.test/',
        httpClient: http,
      });
      await client.health();
      expect(calls[0]?.url).toBe('http://orch.test/health');
    });
  });

  describe('error envelopes (c)(d)', () => {
    it('5xx maps to { available: false, reason: http-error, statusCode }', async () => {
      const { client: http } = stubHttp({
        '/health': { status: 503, data: 'unavailable' },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.health();
      expect(result).toEqual({
        available: false,
        reason: 'http-error',
        statusCode: 503,
      });
    });

    it('4xx maps to { available: false, reason: http-error }', async () => {
      const { client: http } = stubHttp({
        '/queue': { status: 401, data: { error: 'unauthorized' } },
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.getJobs();
      expect(result).toEqual({
        available: false,
        reason: 'http-error',
        statusCode: 401,
      });
    });

    it('network error maps to { available: false, reason: cloud-unreachable }', async () => {
      const { client: http } = stubHttp({
        '/dispatch/queue/workers': new Error('ECONNREFUSED'),
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      const result = await client.getWorkers();
      expect(result).toEqual({
        available: false,
        reason: 'cloud-unreachable',
      });
    });

    it('live client never throws', async () => {
      const { client: http } = stubHttp({
        '/health': new Error('boom'),
        '/queue': new Error('boom'),
        '/dispatch/queue/workers': new Error('boom'),
      });
      const client = createOrchestratorClient({
        token: 'tok',
        httpClient: http,
      });
      await expect(client.health()).resolves.toMatchObject({ available: false });
      await expect(client.getJobs()).resolves.toMatchObject({ available: false });
      await expect(client.getWorkers()).resolves.toMatchObject({ available: false });
    });
  });
});
