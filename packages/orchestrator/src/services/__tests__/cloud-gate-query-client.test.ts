/**
 * Tests for `CloudGateQueryClient` (#1038 T021).
 *
 * The client is single-call by design (retry lives in the MCP tool). These
 * tests exercise:
 *   - request URL shape (query-string encoding, path with clusterId)
 *   - `Authorization: Bearer <key>` header threading
 *   - 200 JSON parsing → typed response (status + list modes)
 *   - 5xx → `CloudTransportError`
 *   - 4xx → `CloudRequestError`
 *   - 200-with-malformed-body → `CloudRequestError`
 *   - AbortController fires after `timeoutMs`
 *   - missing cluster API key file → error surfaces cleanly (not swallowed)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { mkdtemp, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCloudGateQueryClient,
  CloudTransportError,
  CloudRequestError,
  type HttpsRequestImpl,
} from '../cloud-gate-query-client.js';

interface MockRequestCapture {
  options: import('node:https').RequestOptions;
  aborted: boolean;
}

interface MockRequestConfig {
  status?: number;
  body?: string;
  bodyChunks?: string[];
  throw?: Error;
  delay?: number; // Delay before responding — allows AbortController to fire.
}

/**
 * Build a `https.request` seam that captures the outgoing request and returns
 * a fake `ClientRequest` (via EventEmitter + fake .end/.write).
 */
function makeMockRequestImpl(
  config: MockRequestConfig | ((call: MockRequestCapture) => MockRequestConfig),
): { impl: HttpsRequestImpl; captures: MockRequestCapture[] } {
  const captures: MockRequestCapture[] = [];
  const impl: HttpsRequestImpl = ((options: import('node:https').RequestOptions, callback?: (res: import('node:http').IncomingMessage) => void) => {
    const cfg: MockRequestConfig =
      typeof config === 'function' ? config({ options, aborted: false }) : config;
    const capture: MockRequestCapture = { options, aborted: false };
    captures.push(capture);
    const req = new EventEmitter() as unknown as import('node:http').ClientRequest & {
      end: () => void;
      write: () => void;
    };
    req.end = () => {
      const doRespond = () => {
        if (cfg.throw) {
          req.emit('error', cfg.throw);
          return;
        }
        const res = new EventEmitter() as unknown as import('node:http').IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = cfg.status ?? 200;
        callback?.(res);
        const chunks = cfg.bodyChunks ?? (cfg.body !== undefined ? [cfg.body] : ['']);
        for (const c of chunks) {
          res.emit('data', Buffer.from(c, 'utf8'));
        }
        res.emit('end');
      };
      if (cfg.delay && cfg.delay > 0) {
        setTimeout(doRespond, cfg.delay);
      } else {
        setImmediate(doRespond);
      }
    };
    req.write = () => {};
    // Support AbortController via the signal option.
    if ((options as { signal?: AbortSignal }).signal) {
      const signal = (options as { signal?: AbortSignal }).signal!;
      signal.addEventListener('abort', () => {
        capture.aborted = true;
        setImmediate(() => req.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    // Deliberately do NOT satisfy the entire ClientRequest interface — the
    // client only uses .on / .end / .write.
    return req;
  }) as unknown as HttpsRequestImpl;
  return { impl, captures };
}

const CLUSTER_ID = 'clu_abc123';
const API_URL = 'https://api.example.local';
const ISSUE_REF = 'generacy-ai/generacy#1038';

let tempDir: string;
let apiKeyPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cgqc-'));
  apiKeyPath = join(tempDir, 'cluster-api-key');
  await writeFile(apiKeyPath, 'test-api-key-123', 'utf8');
  process.env['GENERACY_API_URL'] = API_URL;
});

afterEach(async () => {
  delete process.env['GENERACY_API_URL'];
  await rm(tempDir, { recursive: true, force: true });
});

const silentLogger = { info: () => {}, warn: () => {} };

describe('CloudGateQueryClient — request shape', () => {
  it('status mode: URL includes issueRef, gateType, generation query params + Bearer header', async () => {
    const { impl, captures } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gateId: 'aa'.repeat(12), status: 'open' }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: 'clarification',
      generation: 'abc123def456',
    });
    expect(captures).toHaveLength(1);
    const opts = captures[0]!.options;
    expect(opts.method).toBe('GET');
    expect(opts.hostname).toBe('api.example.local');
    // Path should include clusterId (percent-encoded) + the gate query string.
    expect(opts.path).toContain(`/api/clusters/${CLUSTER_ID}/cockpit/gates`);
    expect(opts.path).toContain('issueRef=generacy-ai%2Fgeneracy%231038');
    expect(opts.path).toContain('gateType=clarification');
    expect(opts.path).toContain('generation=abc123def456');
    // Authorization header.
    const headers = opts.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-api-key-123');
    expect(headers['accept']).toBe('application/json');
  });

  it('list mode: URL includes issueRef and optional gateType, omits generation', async () => {
    const { impl, captures } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gates: [] }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.listGates({ issueRef: ISSUE_REF, gateType: 'clarification' });
    const opts = captures[0]!.options;
    expect(opts.path).toContain('issueRef=generacy-ai%2Fgeneracy%231038');
    expect(opts.path).toContain('gateType=clarification');
    expect(opts.path).not.toContain('generation=');
  });

  it('list mode without gateType omits both gateType and generation', async () => {
    const { impl, captures } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gates: [] }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.listGates({ issueRef: ISSUE_REF });
    const opts = captures[0]!.options;
    expect(opts.path).toContain('issueRef=generacy-ai%2Fgeneracy%231038');
    expect(opts.path).not.toContain('gateType=');
    expect(opts.path).not.toContain('generation=');
  });
});

describe('CloudGateQueryClient — response parsing', () => {
  it('status 200 → parses gateId + status', async () => {
    const gateId = 'a'.repeat(24);
    const { impl } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gateId, status: 'open' }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    const result = await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: 'clarification',
      generation: 'abc',
    });
    expect(result.gateId).toBe(gateId);
    expect(result.status).toBe('open');
  });

  it('status 200 with null gateId → returns { gateId: null, status: null }', async () => {
    const { impl } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gateId: null, status: null }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    const result = await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: 'clarification',
      generation: 'abc',
    });
    expect(result.gateId).toBeNull();
    expect(result.status).toBeNull();
  });

  it('list 200 → parses gates array + optional truncated', async () => {
    const { impl } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({
        gates: [
          {
            gateId: 'a'.repeat(24),
            gateType: 'clarification',
            generation: 'gen1',
            status: 'open',
          },
          {
            gateId: 'b'.repeat(24),
            gateType: 'implementation-review',
            generation: 'sha123',
            status: 'delivered',
          },
        ],
        truncated: true,
      }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    const result = await client.listGates({ issueRef: ISSUE_REF });
    expect(result.gates).toHaveLength(2);
    expect(result.gates[0]?.status).toBe('open');
    expect(result.gates[1]?.status).toBe('delivered');
    expect(result.truncated).toBe(true);
  });

  it('list 200 without truncated → omits the field (not `false`)', async () => {
    const { impl } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({ gates: [] }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    const result = await client.listGates({ issueRef: ISSUE_REF });
    expect(result.gates).toEqual([]);
    expect('truncated' in result).toBe(false);
  });

  it('list 200: numeric generation is coerced to string', async () => {
    const { impl } = makeMockRequestImpl({
      status: 200,
      body: JSON.stringify({
        gates: [
          {
            gateId: 'a'.repeat(24),
            gateType: 'phase-queue',
            generation: 3,
            status: 'open',
          },
        ],
      }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    const result = await client.listGates({ issueRef: ISSUE_REF });
    expect(result.gates[0]?.generation).toBe('3');
  });
});

describe('CloudGateQueryClient — error mapping', () => {
  for (const status of [500, 502, 503, 504]) {
    it(`${status} → CloudTransportError`, async () => {
      const { impl } = makeMockRequestImpl({ status, body: 'boom' });
      const client = createCloudGateQueryClient({
        clusterId: CLUSTER_ID,
        apiKeyPath,
        httpsRequestImpl: impl,
        logger: silentLogger,
      });
      await expect(
        client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
      ).rejects.toBeInstanceOf(CloudTransportError);
    });
  }

  for (const status of [400, 401, 403, 404, 422]) {
    it(`${status} → CloudRequestError`, async () => {
      const { impl } = makeMockRequestImpl({ status, body: 'bad' });
      const client = createCloudGateQueryClient({
        clusterId: CLUSTER_ID,
        apiKeyPath,
        httpsRequestImpl: impl,
        logger: silentLogger,
      });
      await expect(
        client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
      ).rejects.toBeInstanceOf(CloudRequestError);
    });
  }

  it('200 with malformed JSON → CloudRequestError', async () => {
    const { impl } = makeMockRequestImpl({ status: 200, body: 'not-json' });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await expect(
      client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(CloudRequestError);
  });

  it('200 with missing gates array (list mode) → CloudRequestError', async () => {
    const { impl } = makeMockRequestImpl({ status: 200, body: JSON.stringify({}) });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await expect(client.listGates({ issueRef: ISSUE_REF })).rejects.toBeInstanceOf(
      CloudRequestError,
    );
  });

  it('network error → CloudTransportError', async () => {
    const { impl } = makeMockRequestImpl({
      throw: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await expect(
      client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(CloudTransportError);
  });

  it('AbortController fires after timeout → CloudTransportError', async () => {
    const { impl, captures } = makeMockRequestImpl({ delay: 200 });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      timeoutMs: 10,
      logger: silentLogger,
    });
    await expect(
      client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(CloudTransportError);
    expect(captures[0]!.aborted).toBe(true);
  });

  it('missing cluster API key file → CloudTransportError (not swallowed)', async () => {
    const { impl } = makeMockRequestImpl({ status: 200, body: '{}' });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath: join(tempDir, 'nope-not-a-file'),
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await expect(
      client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(CloudTransportError);
  });

  it('missing GENERACY_API_URL → CloudTransportError', async () => {
    delete process.env['GENERACY_API_URL'];
    const { impl } = makeMockRequestImpl({ status: 200, body: '{}' });
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await expect(
      client.getGateStatus({ issueRef: ISSUE_REF, gateType: 'clarification', generation: 'x' }),
    ).rejects.toBeInstanceOf(CloudTransportError);
  });
});
