import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import http from 'node:http';

import { ControlServer } from '../../src/control-server.js';
import { JwtParser } from '../../src/auth/jwt-parser.js';
import { SessionTokenStore } from '../../src/auth/session-token-store.js';
import { GeneracyCloudBackend } from '../../src/backends/generacy-cloud-backend.js';
import type { SessionManager } from '../../src/session-manager.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function validPayload(): Record<string, unknown> {
  return {
    sub: 'user-42',
    org_id: 'org-99',
    scope: 'credhelper',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** Make an HTTP request over a Unix socket. */
function request(
  socketPath: string,
  method: string,
  urlPath: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { socketPath, method, path: urlPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          if (raw === '') {
            resolve({ status: res.statusCode!, body: null });
          } else {
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(raw) });
            } catch {
              resolve({ status: res.statusCode!, body: raw });
            }
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Integration: Session Token Flow', () => {
  let tmpDir: string;
  let controlSocketPath: string;
  let tokenFilePath: string;
  let controlServer: ControlServer;
  let sessionTokenStore: SessionTokenStore;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-token-flow-'));
    controlSocketPath = path.join(tmpDir, 'control.sock');
    tokenFilePath = path.join(tmpDir, 'session-token');

    const jwtParser = new JwtParser();
    sessionTokenStore = new SessionTokenStore(tokenFilePath, jwtParser);

    const mockSessionManager = {
      beginSession: vi.fn(),
      endSession: vi.fn(),
    };

    controlServer = new ControlServer(
      mockSessionManager as unknown as SessionManager,
      process.getuid?.() ?? 1000,
      false,
      sessionTokenStore,
    );
    await controlServer.start(controlSocketPath);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await controlServer.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('full cycle: login → status → fetch → logout → status', async () => {
    const jwt = makeJwt(validPayload());

    // 1. GET status → not authenticated
    const status1 = await request(controlSocketPath, 'GET', '/auth/session-token/status');
    expect(status1.status).toBe(200);
    expect(status1.body).toEqual({ authenticated: false });

    // 2. PUT session token → 204
    const putRes = await request(controlSocketPath, 'PUT', '/auth/session-token', { token: jwt });
    expect(putRes.status).toBe(204);
    expect(putRes.body).toBeNull();

    // 3. Verify token file was created with mode 0600
    const fileStat = statSync(tokenFilePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const fileContents = await fs.readFile(tokenFilePath, 'utf-8');
    expect(fileContents).toBe(jwt);

    // 4. GET status → authenticated with correct claims
    const status2 = await request(controlSocketPath, 'GET', '/auth/session-token/status');
    expect(status2.status).toBe(200);
    expect(status2.body.authenticated).toBe(true);
    expect(status2.body.user).toBe('user-42');
    expect(status2.body.org).toBe('org-99');
    expect(status2.body.expiresAt).toBeDefined();

    // 5. Verify GeneracyCloudBackend can fetch using the shared token store
    const cloudApiUrl = 'https://api.generacy.test';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ value: 'decrypted-secret-value' }),
    } as unknown as Response);

    const backend = new GeneracyCloudBackend(cloudApiUrl, sessionTokenStore);
    const secretValue = await backend.fetchSecret('my-stripe-key');

    expect(secretValue).toBe('decrypted-secret-value');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify correct URL construction
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      `${cloudApiUrl}/api/organizations/org-99/credentials/my-stripe-key/resolve`,
    );

    // Verify correct Authorization header
    const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(callOpts.method).toBe('POST');
    expect((callOpts.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${jwt}`);

    // 6. DELETE session token → 204
    const deleteRes = await request(controlSocketPath, 'DELETE', '/auth/session-token');
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toBeNull();

    // 7. Verify token file deleted
    const fileExists = await fs.stat(tokenFilePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);

    // 8. GET status → not authenticated again
    const status3 = await request(controlSocketPath, 'GET', '/auth/session-token/status');
    expect(status3.status).toBe(200);
    expect(status3.body).toEqual({ authenticated: false });

    // 9. Verify backend now throws BACKEND_AUTH_REQUIRED
    mockFetch.mockClear();
    await expect(backend.fetchSecret('my-stripe-key')).rejects.toThrow(/requires authentication/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('loadFromDisk restores token across store instances', async () => {
    const jwt = makeJwt(validPayload());

    // Store a token via the control server
    const putRes = await request(controlSocketPath, 'PUT', '/auth/session-token', { token: jwt });
    expect(putRes.status).toBe(204);

    // Create a new SessionTokenStore (simulating daemon restart)
    const freshParser = new JwtParser();
    const freshStore = new SessionTokenStore(tokenFilePath, freshParser);

    // Before loading, token should be null
    expect(await freshStore.getToken()).toBeNull();

    // Load from disk
    await freshStore.loadFromDisk();

    // Token should be restored
    const token = await freshStore.getToken();
    expect(token).not.toBeNull();
    expect(token!.value).toBe(jwt);
    expect(token!.claims.sub).toBe('user-42');
    expect(token!.claims.org_id).toBe('org-99');

    // Status should show authenticated
    const status = freshStore.getStatus();
    expect(status.authenticated).toBe(true);
    if (status.authenticated) {
      expect(status.user).toBe('user-42');
      expect(status.org).toBe('org-99');
    }
  });

  it('rejects invalid JWT via control server', async () => {
    const res = await request(controlSocketPath, 'PUT', '/auth/session-token', {
      token: 'not-a-valid-jwt',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOKEN');

    // Status should still be unauthenticated
    const status = await request(controlSocketPath, 'GET', '/auth/session-token/status');
    expect(status.body).toEqual({ authenticated: false });

    // Token file should not exist
    const fileExists = await fs.stat(tokenFilePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);
  });

  it('cloud backend maps 401 to BackendAuthExpiredError', async () => {
    const jwt = makeJwt(validPayload());
    await request(controlSocketPath, 'PUT', '/auth/session-token', { token: jwt });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);

    const backend = new GeneracyCloudBackend('https://api.generacy.test', sessionTokenStore);
    await expect(backend.fetchSecret('some-key')).rejects.toThrow(/expired/);
  });
});
