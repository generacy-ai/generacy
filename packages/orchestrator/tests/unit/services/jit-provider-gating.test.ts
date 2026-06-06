import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  JitTokenError,
  type JitGitTokenClient,
  type JitGitTokenResponse,
} from '@generacy-ai/control-plane';
import {
  createJitGithubTokenProvider,
  WIZARD_SENTINEL_KEY,
} from '../../../src/services/jit-github-token-provider.js';
import { clusterApiKeyExists } from '../../../src/services/cluster-api-key-probe.js';

/**
 * #777 — Integration-style test for the three gating outcomes that server.ts
 * implements via `clusterApiKeyExists() ? createJitGithubTokenProvider(...) : undefined`.
 *
 * The full server is too heavy to boot in unit tests, so this exercises the
 * composed gating logic directly. The server.ts wiring is a one-line ternary
 * over these primitives.
 */
describe('JIT GitHub token provider gating (#777)', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'jit-gating-'));
    originalEnv = process.env['CLUSTER_API_KEY_PATH'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['CLUSTER_API_KEY_PATH'] = originalEnv;
    } else {
      delete process.env['CLUSTER_API_KEY_PATH'];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn() };
  }

  function makeAuthHealth() {
    return { recordResult: vi.fn() };
  }

  function makeClient(): JitGitTokenClient & {
    fetch: ReturnType<typeof vi.fn>;
  } {
    return {
      fetch: vi.fn(
        async (): Promise<JitGitTokenResponse> => ({
          token: 'ghs_token',
          expiresAt: new Date(Date.now() + 60 * 60_000),
        }),
      ),
    } as JitGitTokenClient & { fetch: ReturnType<typeof vi.fn> };
  }

  /**
   * Mirror the gating logic from `packages/orchestrator/src/server.ts`:
   *   clusterApiKeyExists() ? createJitGithubTokenProvider({...}) : undefined
   */
  function buildProvider(opts: {
    client: JitGitTokenClient;
    credentialId?: string;
    authHealth?: { recordResult: ReturnType<typeof vi.fn> };
  }) {
    if (!clusterApiKeyExists()) return undefined;
    return createJitGithubTokenProvider({
      client: opts.client,
      credentialId: opts.credentialId,
      authHealth: opts.authHealth,
      logger: makeLogger(),
    });
  }

  // -------------------------------------------------------------
  // Case 1: descriptor present + api-key present
  // -------------------------------------------------------------
  it('descriptor present + api-key present → provider constructed, descriptor credentialId used (sentinel NOT used)', async () => {
    const keyPath = path.join(tempDir, 'cluster-api-key');
    writeFileSync(keyPath, 'k');
    process.env['CLUSTER_API_KEY_PATH'] = keyPath;

    const client = makeClient();
    const authHealth = makeAuthHealth();

    // Force the provider to fail so authHealth is called and we can inspect the key.
    client.fetch.mockImplementationOnce(async () => {
      throw new JitTokenError('CLOUD_AUTH_REJECTED', 'rejected');
    });

    const provider = buildProvider({
      client,
      credentialId: 'cred-real',
      authHealth,
    });

    expect(provider).toBeDefined();
    await expect(provider!()).rejects.toBeInstanceOf(JitTokenError);

    // client.fetch was called with the real credentialId (not undefined)
    expect(client.fetch).toHaveBeenCalledWith('cred-real');
    // authHealth keyed by the real id, not the sentinel
    expect(authHealth.recordResult).toHaveBeenCalledWith('cred-real', {
      ok: false,
      statusCode: 503,
    });
    expect(authHealth.recordResult).not.toHaveBeenCalledWith(
      WIZARD_SENTINEL_KEY,
      expect.anything(),
    );
  });

  // -------------------------------------------------------------
  // Case 2: no descriptor + api-key present (wizard-bootstrapped cluster)
  // -------------------------------------------------------------
  it('no descriptor + api-key present → provider constructed credential-less, sentinel used', async () => {
    const keyPath = path.join(tempDir, 'cluster-api-key');
    writeFileSync(keyPath, 'k');
    process.env['CLUSTER_API_KEY_PATH'] = keyPath;

    const client = makeClient();
    const authHealth = makeAuthHealth();

    // Force the provider to fail so authHealth is called and we can inspect the key.
    client.fetch.mockImplementationOnce(async () => {
      throw new JitTokenError('CLOUD_UNREACHABLE', 'down');
    });

    const provider = buildProvider({
      client,
      credentialId: undefined,
      authHealth,
    });

    expect(provider).toBeDefined();
    await expect(provider!()).rejects.toBeInstanceOf(JitTokenError);

    // client.fetch called credential-less
    expect(client.fetch).toHaveBeenCalledWith(undefined);
    // authHealth keyed by the sentinel
    expect(authHealth.recordResult).toHaveBeenCalledWith(WIZARD_SENTINEL_KEY, {
      ok: false,
      statusCode: 503,
    });
  });

  // Cache + sentinel keying coherence
  it('no descriptor + api-key present → cache keyed by sentinel (second call hits cache)', async () => {
    const keyPath = path.join(tempDir, 'cluster-api-key');
    writeFileSync(keyPath, 'k');
    process.env['CLUSTER_API_KEY_PATH'] = keyPath;

    const client = makeClient();
    const provider = buildProvider({ client, credentialId: undefined });

    expect(provider).toBeDefined();
    await provider!();
    await provider!();

    // Cache hit on the second call — sentinel-keyed set/get are consistent.
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------
  // Case 3: no api-key (truly-unconfigured / offline cluster)
  // -------------------------------------------------------------
  it('no api-key → provider is undefined (legacy fallback)', () => {
    // Point CLUSTER_API_KEY_PATH at a non-existent file
    process.env['CLUSTER_API_KEY_PATH'] = path.join(tempDir, 'absent');

    const client = makeClient();
    const provider = buildProvider({ client, credentialId: 'cred-real' });

    expect(provider).toBeUndefined();
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it('no api-key + no descriptor → provider is undefined (legacy fallback)', () => {
    process.env['CLUSTER_API_KEY_PATH'] = path.join(tempDir, 'absent');

    const client = makeClient();
    const provider = buildProvider({ client, credentialId: undefined });

    expect(provider).toBeUndefined();
  });
});
