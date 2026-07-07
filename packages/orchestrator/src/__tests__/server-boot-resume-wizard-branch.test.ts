// SC-003 guard — deleting the resume dispatch from `post-activation-dispatch.ts`
// or from the wizard branch call site MUST make Case 1 (below) fail.
//
// This test drives createServer() with an empty relay.apiKey so activateInBackground()
// runs, then asserts that BootResumeService.triggerBootResume() fires after activation
// resolves when checkPostActivationState() returns { activated: true, postActivationComplete: true }.

import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';

// State that the mocked PostActivationRetryService.checkPostActivationState() will return.
// Mutated per test case.
const checkStateResult: {
  value: { activated: boolean; postActivationComplete: boolean; needsRetry: boolean };
} = {
  value: { activated: true, postActivationComplete: true, needsRetry: false },
};

const triggerBootResumeMock = vi.fn().mockResolvedValue(undefined);
const triggerPostActivationRetryMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../activation/index.js', () => ({
  activate: vi.fn(),
}));

vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    isConnected: false,
  })),
}));

vi.mock('@generacy-ai/control-plane', () => ({
  TunnelHandler: vi.fn().mockImplementation(() => ({})),
  getCodeServerManager: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/boot-resume-service.js', () => ({
  BootResumeService: vi.fn().mockImplementation(() => ({
    triggerBootResume: triggerBootResumeMock,
  })),
}));

vi.mock('../services/post-activation-retry.js', () => ({
  PostActivationRetryService: vi.fn().mockImplementation(() => ({
    checkPostActivationState: vi.fn(() => checkStateResult.value),
    triggerPostActivationRetry: triggerPostActivationRetryMock,
  })),
}));

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import { activate } from '../activation/index.js';

const activateMock = activate as Mock;

function buildConfig(overrides: Partial<Parameters<typeof createTestConfig>[0]> = {}) {
  return createTestConfig({
    server: { port: 0, host: '127.0.0.1' },
    redis: { url: 'redis://127.0.0.1:1' },
    auth: {
      enabled: false,
      providers: [],
      jwt: { secret: 'test-secret-at-least-32-characters-long', expiresIn: '1h' },
    },
    logging: { level: 'error', pretty: false },
    ...overrides,
  });
}

describe('Wizard branch: post-activation dispatch (#834)', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    triggerBootResumeMock.mockClear();
    triggerPostActivationRetryMock.mockClear();
    activateMock.mockReset();
  });

  it('Case 1 (SC-003 guard): triggerBootResume fires on wizard branch when state is activated + complete', async () => {
    checkStateResult.value = {
      activated: true,
      postActivationComplete: true,
      needsRetry: false,
    };

    activateMock.mockResolvedValue({
      apiKey: 'test-api-key',
      clusterApiKeyId: 'test-key-id',
      clusterId: 'test-cluster',
      projectId: 'test-project',
      orgId: 'test-org',
      cloudUrl: 'https://test.example.com',
    });

    const config = buildConfig({
      relay: {
        apiKey: undefined,
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(triggerBootResumeMock).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    expect(triggerPostActivationRetryMock).not.toHaveBeenCalled();
  }, 15_000);

  it('Case 2: triggerBootResume does NOT fire when state is needsRetry', async () => {
    checkStateResult.value = {
      activated: true,
      postActivationComplete: false,
      needsRetry: true,
    };

    activateMock.mockResolvedValue({
      apiKey: 'test-api-key',
      clusterApiKeyId: 'test-key-id',
      clusterId: 'test-cluster',
      projectId: 'test-project',
      orgId: 'test-org',
      cloudUrl: 'https://test.example.com',
    });

    const config = buildConfig({
      relay: {
        apiKey: undefined,
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(triggerPostActivationRetryMock).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    expect(triggerBootResumeMock).not.toHaveBeenCalled();
  }, 15_000);

  it('Case 3: triggerBootResume does NOT fire on first-boot (!activated)', async () => {
    checkStateResult.value = {
      activated: false,
      postActivationComplete: false,
      needsRetry: false,
    };

    activateMock.mockResolvedValue({
      apiKey: 'test-api-key',
      clusterApiKeyId: 'test-key-id',
      clusterId: 'test-cluster',
      projectId: 'test-project',
      orgId: 'test-org',
      cloudUrl: 'https://test.example.com',
    });

    const config = buildConfig({
      relay: {
        apiKey: undefined,
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(activateMock).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    // Give the async dispatch a tick to fire (or not).
    await new Promise((r) => setTimeout(r, 200));

    expect(triggerBootResumeMock).not.toHaveBeenCalled();
    expect(triggerPostActivationRetryMock).not.toHaveBeenCalled();
  }, 15_000);
});
