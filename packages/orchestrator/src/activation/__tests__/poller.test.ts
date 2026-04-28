import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollForApproval } from '../poller.js';
import type { HttpClient, HttpResponse, PollResponse } from '../types.js';
import type { Logger } from 'pino';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

describe('pollForApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns approved response after pending', async () => {
    const responses: PollResponse[] = [
      { status: 'authorization_pending' },
      { status: 'authorization_pending' },
      {
        status: 'approved',
        cluster_api_key: 'key_123',
        cluster_api_key_id: 'kid_123',
        cluster_id: 'cluster_1',
        project_id: 'proj_1',
        org_id: 'org_1',
      },
    ];

    let callIndex = 0;
    const httpClient: HttpClient = {
      post: vi.fn(async () => ({
        status: 200,
        data: responses[callIndex++],
      })) as HttpClient['post'],
    };

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc_test',
      interval: 1,
      expiresIn: 30,
      httpClient,
      logger: createMockLogger(),
    });

    // Advance through 3 poll intervals
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.status).toBe('approved');
    if (result.status === 'approved') {
      expect(result.cluster_api_key).toBe('key_123');
    }
  });

  it('increases interval by 5s on slow_down', async () => {
    const responses: PollResponse[] = [
      { status: 'slow_down' },
      {
        status: 'approved',
        cluster_api_key: 'key_123',
        cluster_api_key_id: 'kid_123',
        cluster_id: 'cluster_1',
        project_id: 'proj_1',
        org_id: 'org_1',
      },
    ];

    let callIndex = 0;
    const httpClient: HttpClient = {
      post: vi.fn(async () => ({
        status: 200,
        data: responses[callIndex++],
      })) as HttpClient['post'],
    };

    const logger = createMockLogger();
    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc_test',
      interval: 5,
      expiresIn: 60,
      httpClient,
      logger,
    });

    // First poll at 5s
    await vi.advanceTimersByTimeAsync(5000);
    // After slow_down, interval becomes 10s
    await vi.advanceTimersByTimeAsync(10000);

    const result = await promise;
    expect(result.status).toBe('approved');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('10s'));
  });

  it('returns expired when device code expires', async () => {
    const httpClient: HttpClient = {
      post: vi.fn(async () => ({
        status: 200,
        data: { status: 'expired' },
      })) as HttpClient['post'],
    };

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc_test',
      interval: 5,
      expiresIn: 30,
      httpClient,
      logger: createMockLogger(),
    });

    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe('expired');
  });

  it('respects expires_in timeout bound', async () => {
    const httpClient: HttpClient = {
      post: vi.fn(async () => ({
        status: 200,
        data: { status: 'authorization_pending' },
      })) as HttpClient['post'],
    };

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc_test',
      interval: 2,
      expiresIn: 5,
      httpClient,
      logger: createMockLogger(),
    });

    // Advance past expires_in
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.status).toBe('expired');
  });

  it('caps interval at 60s maximum', async () => {
    // Generate 12 slow_down responses to push interval to 65s (5 + 12*5 = 65 > 60)
    const responses: PollResponse[] = Array.from({ length: 12 }, () => ({ status: 'slow_down' as const }));
    responses.push({
      status: 'approved',
      cluster_api_key: 'key_123',
      cluster_api_key_id: 'kid_123',
      cluster_id: 'cluster_1',
      project_id: 'proj_1',
      org_id: 'org_1',
    });

    let callIndex = 0;
    const httpClient: HttpClient = {
      post: vi.fn(async () => ({
        status: 200,
        data: responses[callIndex++],
      })) as HttpClient['post'],
    };

    const logger = createMockLogger();
    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc_test',
      interval: 5,
      expiresIn: 600,
      httpClient,
      logger,
    });

    // Advance through all polls
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const result = await promise;
    expect(result.status).toBe('approved');
    // Verify that one of the info calls mentions 60s as the cap
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const hasCappedInterval = infoCalls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('60s'),
    );
    expect(hasCappedInterval).toBe(true);
  });
});
