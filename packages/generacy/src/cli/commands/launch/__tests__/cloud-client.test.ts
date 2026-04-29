import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { fetchLaunchConfig } from '../cloud-client.js';

// ---------------------------------------------------------------------------
// Test HTTP server — assigns a per-test handler for flexible response control
// ---------------------------------------------------------------------------

let server: Server;
let serverUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Valid fixture matching LaunchConfigSchema
// ---------------------------------------------------------------------------

const VALID_LAUNCH_CONFIG = {
  projectId: 'proj_abc123',
  projectName: 'my-project',
  variant: 'standard',
  cloudUrl: 'https://api.generacy.ai',
  clusterId: 'cluster_abc123',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
  repos: { primary: 'generacy-ai/example-project' },
};

// ---------------------------------------------------------------------------
// Stub mode
// ---------------------------------------------------------------------------

describe('fetchLaunchConfig — stub mode', () => {
  let savedStub: string | undefined;

  beforeEach(() => {
    savedStub = process.env['GENERACY_LAUNCH_STUB'];
    process.env['GENERACY_LAUNCH_STUB'] = '1';
  });

  afterEach(() => {
    if (savedStub !== undefined) {
      process.env['GENERACY_LAUNCH_STUB'] = savedStub;
    } else {
      delete process.env['GENERACY_LAUNCH_STUB'];
    }
  });

  it('returns fixture without HTTP call when GENERACY_LAUNCH_STUB=1', async () => {
    // Use a URL that would fail if a real request were made
    const config = await fetchLaunchConfig('http://localhost:1', 'any-code');

    expect(config).toMatchObject({
      projectId: expect.any(String),
      projectName: expect.any(String),
      variant: expect.any(String),
      cloudUrl: expect.any(String),
      clusterId: expect.any(String),
      imageTag: expect.any(String),
      repos: expect.objectContaining({ primary: expect.any(String) }),
    });
  });
});

// ---------------------------------------------------------------------------
// Live HTTP tests
// ---------------------------------------------------------------------------

describe('fetchLaunchConfig — HTTP', () => {
  let savedStub: string | undefined;

  beforeEach(() => {
    // Ensure stub mode is off for real HTTP tests
    savedStub = process.env['GENERACY_LAUNCH_STUB'];
    delete process.env['GENERACY_LAUNCH_STUB'];
  });

  afterEach(() => {
    if (savedStub !== undefined) {
      process.env['GENERACY_LAUNCH_STUB'] = savedStub;
    } else {
      delete process.env['GENERACY_LAUNCH_STUB'];
    }
  });

  it('returns validated LaunchConfig on successful fetch', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VALID_LAUNCH_CONFIG));
    };

    const config = await fetchLaunchConfig(serverUrl, 'valid-claim');

    expect(config).toEqual(VALID_LAUNCH_CONFIG);
  });

  it('sends claim code as query parameter', async () => {
    let capturedUrl: string | undefined;

    handler = (req, res) => {
      capturedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VALID_LAUNCH_CONFIG));
    };

    await fetchLaunchConfig(serverUrl, 'my-claim-code');

    expect(capturedUrl).toBe('/api/clusters/launch-config?claim=my-claim-code');
  });

  it('throws "Claim code is invalid or expired" on 4xx response', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    };

    await expect(fetchLaunchConfig(serverUrl, 'bad-claim')).rejects.toThrow(
      'Claim code is invalid or expired',
    );
  });

  it('throws "Claim code is invalid or expired" on 400 response', async () => {
    handler = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    };

    await expect(fetchLaunchConfig(serverUrl, 'bad-claim')).rejects.toThrow(
      'Claim code is invalid or expired',
    );
  });

  it('throws "Could not reach Generacy cloud" on network error', async () => {
    // Use a URL pointing to a port where nothing is listening
    await expect(fetchLaunchConfig('http://127.0.0.1:1', 'any-code')).rejects.toThrow(
      'Could not reach Generacy cloud',
    );
  });

  it('throws "Could not reach Generacy cloud" on 5xx response', async () => {
    handler = (_req, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad gateway' }));
    };

    await expect(fetchLaunchConfig(serverUrl, 'some-claim')).rejects.toThrow(
      'Could not reach Generacy cloud',
    );
  });

  it('throws "Invalid response from cloud" on malformed JSON', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json{{{');
    };

    await expect(fetchLaunchConfig(serverUrl, 'some-claim')).rejects.toThrow(
      'Invalid response from cloud',
    );
  });

  it('throws "Invalid response from cloud" on schema validation failure', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Missing required fields (projectId, clusterId, imageTag, repos, etc.)
      res.end(JSON.stringify({ projectName: 'incomplete' }));
    };

    await expect(fetchLaunchConfig(serverUrl, 'some-claim')).rejects.toThrow(
      'Invalid response from cloud',
    );
  });

  it('throws "Invalid response from cloud" when cloudUrl is not a valid URL', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...VALID_LAUNCH_CONFIG,
          cloudUrl: 'not-a-url',
        }),
      );
    };

    await expect(fetchLaunchConfig(serverUrl, 'some-claim')).rejects.toThrow(
      'Invalid response from cloud',
    );
  });
});
