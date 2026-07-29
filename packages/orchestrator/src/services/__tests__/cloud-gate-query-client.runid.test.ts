/**
 * `runId` acceptance on `CloudGateQueryClient` (#1067 Phase B).
 *
 * SC-001 / SC-003 assertions from `specs/1067-problem-generacy-1053-s/`.
 *
 *   - SC-001a: snapshot equality of the outbound URL when `runId` is OMITTED.
 *     Full canonical URL is checked byte-for-byte against
 *     `contracts/cloud-url.md § "runId OMITTED"`.
 *   - SC-001b: structural — the query-string key set is exactly
 *     `['issueRef', 'gateType', 'generation']` and `.has('runId') === false`.
 *   - SC-003a: with `runId` supplied, the outbound URL matches the canonical
 *     from `contracts/cloud-url.md § "runId SUPPLIED"` and
 *     `searchParams.get('runId') === '<value>'`.
 *   - SC-003b: `listGates` never carries `runId` — even under a defensive
 *     type-cast escape hatch spike.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCloudGateQueryClient,
  type HttpsRequestImpl,
} from '../cloud-gate-query-client.js';

interface MockRequestCapture {
  options: import('node:https').RequestOptions;
}

function makeMockRequestImpl(
  status: number,
  body: string,
): { impl: HttpsRequestImpl; captures: MockRequestCapture[] } {
  const captures: MockRequestCapture[] = [];
  const impl: HttpsRequestImpl = ((
    options: import('node:https').RequestOptions,
    callback?: (res: import('node:http').IncomingMessage) => void,
  ) => {
    captures.push({ options });
    const req = new EventEmitter() as unknown as import('node:http').ClientRequest & {
      end: () => void;
      write: () => void;
    };
    req.end = () => {
      const res = new EventEmitter() as unknown as import('node:http').IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = status;
      setImmediate(() => {
        callback?.(res);
        res.emit('data', Buffer.from(body, 'utf8'));
        res.emit('end');
      });
    };
    req.write = () => {};
    return req;
  }) as unknown as HttpsRequestImpl;
  return { impl, captures };
}

// From contracts/cloud-url.md § Canonical inputs.
const CLUSTER_ID = 'cluster-abc-123';
const API_URL = 'https://api.generacy.ai';
const ISSUE_REF = 'generacy-ai/generacy#42';
const GATE_TYPE = 'implementation-review' as const;
const GENERATION = 'abc123';
const RUN_ID = 'auto-cluster-1067-1722243247891';

// Canonical URLs from contracts/cloud-url.md.
const URL_STATUS_NO_RUNID =
  'https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review&generation=abc123';
const URL_STATUS_WITH_RUNID =
  'https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review&generation=abc123&runId=auto-cluster-1067-1722243247891';

let tempDir: string;
let apiKeyPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cgqc-1067-'));
  apiKeyPath = join(tempDir, 'cluster-api-key');
  await writeFile(apiKeyPath, 'test-api-key-1067', 'utf8');
  process.env['GENERACY_API_URL'] = API_URL;
});

afterEach(async () => {
  delete process.env['GENERACY_API_URL'];
  await rm(tempDir, { recursive: true, force: true });
});

const silentLogger = { info: () => {}, warn: () => {} };

function reconstructUrl(opts: import('node:https').RequestOptions): string {
  const scheme = String(opts.protocol ?? 'https:').replace(/:$/, '');
  const port = opts.port;
  const host = opts.hostname ?? '';
  const path = opts.path ?? '';
  // Omit default ports from the reconstructed URL so it matches the canonical form.
  const isDefaultPort =
    (scheme === 'https' && String(port) === '443') ||
    (scheme === 'http' && String(port) === '80');
  const hostPort = port && !isDefaultPort ? `${host}:${port}` : String(host);
  return `${scheme}://${hostPort}${path}`;
}

describe('CloudGateQueryClient — runId (#1067)', () => {
  it('SC-001a: getGateStatus without runId → outbound URL is byte-identical to the canonical no-runId URL', async () => {
    const { impl, captures } = makeMockRequestImpl(
      200,
      JSON.stringify({ gateId: 'a'.repeat(24), status: 'open' }),
    );
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: GATE_TYPE,
      generation: GENERATION,
    });
    expect(captures).toHaveLength(1);
    const actualUrl = reconstructUrl(captures[0]!.options);
    expect(actualUrl).toBe(URL_STATUS_NO_RUNID);
  });

  it('SC-001b: getGateStatus without runId → searchParams keys are exactly [issueRef, gateType, generation]; runId absent', async () => {
    const { impl, captures } = makeMockRequestImpl(
      200,
      JSON.stringify({ gateId: 'a'.repeat(24), status: 'open' }),
    );
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: GATE_TYPE,
      generation: GENERATION,
    });
    const url = new URL(reconstructUrl(captures[0]!.options));
    const keys = Array.from(url.searchParams.keys());
    expect(keys).toEqual(['issueRef', 'gateType', 'generation']);
    expect(url.searchParams.has('runId')).toBe(false);
  });

  it('SC-003a: getGateStatus with runId → outbound URL matches canonical runId-supplied URL and searchParams.get("runId") === value', async () => {
    const { impl, captures } = makeMockRequestImpl(
      200,
      JSON.stringify({ gateId: 'a'.repeat(24), status: 'open' }),
    );
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    await client.getGateStatus({
      issueRef: ISSUE_REF,
      gateType: GATE_TYPE,
      generation: GENERATION,
      runId: RUN_ID,
    });
    const actualUrl = reconstructUrl(captures[0]!.options);
    expect(actualUrl).toBe(URL_STATUS_WITH_RUNID);
    const url = new URL(actualUrl);
    expect(url.searchParams.get('runId')).toBe(RUN_ID);
  });

  it('SC-003b: listGates never emits runId even if callers spike a defensive escape-hatch pass', async () => {
    const { impl, captures } = makeMockRequestImpl(
      200,
      JSON.stringify({ gates: [] }),
    );
    const client = createCloudGateQueryClient({
      clusterId: CLUSTER_ID,
      apiKeyPath,
      httpsRequestImpl: impl,
      logger: silentLogger,
    });
    // Type-cast escape hatch: prove that even when a rogue caller sneaks a
    // `runId` field into the list-mode input, the client does not carry it on
    // the outbound URL (ListGatesInput's typed surface omits it — the
    // narrowing at getGateStatus vs listGates in the client body is the
    // sole guarantee).
    await client.listGates({
      issueRef: ISSUE_REF,
      gateType: GATE_TYPE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ runId: RUN_ID } as any),
    });
    const url = new URL(reconstructUrl(captures[0]!.options));
    expect(url.searchParams.has('runId')).toBe(false);
    expect(url.searchParams.get('runId')).toBeNull();
  });
});
