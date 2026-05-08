import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { fetchLaunchConfig } from '../cloud-client.js';
import { CloudError } from '../cloud-error.js';
import { LaunchConfigSchema } from '../types.js';

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
  variant: 'cluster-base',
  cloudUrl: 'https://api.generacy.ai',
  clusterId: 'cluster_abc123',
  imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
  orgId: 'org_abc123',
  repos: {
    primary: 'generacy-ai/example-project',
    dev: ['generacy-ai/dev-tools', 'generacy-ai/dev-config'],
    clone: ['generacy-ai/shared-lib'],
  },
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

  describe('differentiated 4xx errors', () => {
    it('throws CloudError with statusCode 400 and message containing "rejected the claim format"', async () => {
      handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(400);
        expect(ce.message).toContain('rejected the claim format');
      }
    });

    it('throws CloudError with statusCode 401 and message containing "unauthenticated"', async () => {
      handler = (_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(401);
        expect(ce.message).toContain('unauthenticated');
      }
    });

    it('throws CloudError with statusCode 403 and message containing "unauthenticated"', async () => {
      handler = (_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(403);
        expect(ce.message).toContain('unauthenticated');
      }
    });

    it('throws CloudError with statusCode 404 and message containing "not found" and "GENERACY_CLOUD_URL"', async () => {
      handler = (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(404);
        expect(ce.message).toContain('not found');
        expect(ce.message).toContain('GENERACY_CLOUD_URL');
      }
    });

    it('throws CloudError with statusCode 410 and message containing "consumed or expired"', async () => {
      handler = (_req, res) => {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'gone' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(410);
        expect(ce.message).toContain('consumed or expired');
      }
    });

    it('throws CloudError with retryAfter populated from Retry-After header on 429', async () => {
      handler = (_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        res.end(JSON.stringify({ error: 'too many requests' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(429);
        expect(ce.retryAfter).toBe('30');
      }
    });

    it('throws CloudError with message containing "Cloud returned 418" for other 4xx codes', async () => {
      handler = (_req, res) => {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "I'm a teapot" }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.statusCode).toBe(418);
        expect(ce.message).toContain('Cloud returned 418');
      }
    });

    it('includes detail field from JSON body in error message', async () => {
      handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'claim format invalid' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.detail).toBe('claim format invalid');
        expect(ce.message).toContain('claim format invalid');
      }
    });

    it('includes sanitized body in error message for non-JSON responses', async () => {
      handler = (_req, res) => {
        res.writeHead(422, { 'Content-Type': 'text/html' });
        res.end('<html>Bad Request</html>');
      };

      try {
        await fetchLaunchConfig(serverUrl, 'bad-claim');
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.message).toContain('<html>Bad Request</html>');
      }
    });

    it('does not leak raw claim code in error url or message', async () => {
      const secretClaim = 'super-secret-claim-code-12345';

      handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      };

      try {
        await fetchLaunchConfig(serverUrl, secretClaim);
        expect.fail('Expected CloudError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudError);
        const ce = error as CloudError;
        expect(ce.url).not.toContain(secretClaim);
        expect(ce.message).not.toContain(secretClaim);
      }
    });
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

  it('validates multi-repo response with dev and clone arrays', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VALID_LAUNCH_CONFIG));
    };

    const config = await fetchLaunchConfig(serverUrl, 'multi-repo-claim');

    expect(config.repos.dev).toEqual(['generacy-ai/dev-tools', 'generacy-ai/dev-config']);
    expect(config.repos.clone).toEqual(['generacy-ai/shared-lib']);
  });

  it('validates response with empty dev and clone arrays', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...VALID_LAUNCH_CONFIG,
        repos: { primary: 'generacy-ai/example-project', dev: [], clone: [] },
      }));
    };

    const config = await fetchLaunchConfig(serverUrl, 'empty-repos-claim');

    expect(config.repos.dev).toEqual([]);
    expect(config.repos.clone).toEqual([]);
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

  it('parses successfully with cloud object present', async () => {
    const configWithCloud = {
      ...VALID_LAUNCH_CONFIG,
      cloud: {
        apiUrl: 'https://api-staging.generacy.ai',
        appUrl: 'https://staging.generacy.ai',
        relayUrl: 'wss://api-staging.generacy.ai/relay?projectId=proj_abc123',
      },
    };

    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(configWithCloud));
    };

    const config = await fetchLaunchConfig(serverUrl, 'cloud-claim');
    expect(config.cloud).toEqual(configWithCloud.cloud);
  });

  it('parses successfully without cloud object (backward compat)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VALID_LAUNCH_CONFIG));
    };

    const config = await fetchLaunchConfig(serverUrl, 'no-cloud-claim');
    expect(config.cloud).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LaunchConfigSchema — cloud object validation
// ---------------------------------------------------------------------------

describe('LaunchConfigSchema — cloud object', () => {
  const BASE = {
    projectId: 'proj_abc123',
    projectName: 'my-project',
    variant: 'cluster-base',
    cloudUrl: 'https://api.generacy.ai',
    clusterId: 'cluster_abc123',
    imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
    orgId: 'org_abc123',
    repos: { primary: 'generacy-ai/example-project' },
  };

  it('parses with cloud object present', () => {
    const result = LaunchConfigSchema.safeParse({
      ...BASE,
      cloud: {
        apiUrl: 'https://api-staging.generacy.ai',
        appUrl: 'https://staging.generacy.ai',
        relayUrl: 'wss://api-staging.generacy.ai/relay?projectId=proj_abc123',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cloud?.apiUrl).toBe('https://api-staging.generacy.ai');
    }
  });

  it('parses without cloud object (backward compat)', () => {
    const result = LaunchConfigSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cloud).toBeUndefined();
    }
  });

  it('rejects invalid URLs in cloud object', () => {
    const result = LaunchConfigSchema.safeParse({
      ...BASE,
      cloud: {
        apiUrl: 'not-a-url',
        appUrl: 'https://staging.generacy.ai',
        relayUrl: 'wss://api-staging.generacy.ai/relay',
      },
    });
    expect(result.success).toBe(false);
  });

  it('cloud fields are independently validated', () => {
    const result = LaunchConfigSchema.safeParse({
      ...BASE,
      cloud: {
        apiUrl: 'https://api.generacy.ai',
        appUrl: 'bad-url',
        relayUrl: 'wss://api.generacy.ai/relay',
      },
    });
    expect(result.success).toBe(false);
  });
});
