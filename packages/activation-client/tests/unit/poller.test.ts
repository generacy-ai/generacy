import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollForApproval } from '../../src/poller.js';
import type { HttpClient, PollResponse } from '../../src/types.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function mockHttpClientWithResponses(responses: PollResponse[]): HttpClient {
  let callIndex = 0;
  return {
    post: vi.fn(async () => {
      const data = responses[callIndex++];
      if (!data) throw new Error('No more mock responses');
      return { status: 200, data };
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('pollForApproval', () => {
  it('returns approved response immediately', async () => {
    const approved: PollResponse = {
      status: 'approved',
      cluster_api_key: 'key-1',
      cluster_api_key_id: 'kid-1',
      cluster_id: 'cl-1',
      project_id: 'pj-1',
      org_id: 'org-1',
    };
    const client = mockHttpClientWithResponses([approved]);

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc-123',
      interval: 1,
      expiresIn: 60,
      httpClient: client,
      logger: mockLogger(),
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.status).toBe('approved');
  });

  it('handles slow_down by increasing interval', async () => {
    const responses: PollResponse[] = [
      { status: 'slow_down' },
      {
        status: 'approved',
        cluster_api_key: 'key-2',
        cluster_api_key_id: 'kid-2',
        cluster_id: 'cl-2',
        project_id: 'pj-2',
        org_id: 'org-2',
      },
    ];
    const client = mockHttpClientWithResponses(responses);
    const logger = mockLogger();

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc-123',
      interval: 1,
      expiresIn: 60,
      httpClient: client,
      logger,
    });

    // First poll after 1s
    await vi.advanceTimersByTimeAsync(1000);
    // slow_down response → interval becomes 1s + 5s = 6s
    // Second poll after 6s
    await vi.advanceTimersByTimeAsync(6000);

    const result = await promise;
    expect(result.status).toBe('approved');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('6s'));
  });

  it('returns expired when deadline passes', async () => {
    const client = mockHttpClientWithResponses([
      { status: 'authorization_pending' },
      { status: 'authorization_pending' },
    ]);

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc-123',
      interval: 2,
      expiresIn: 3,
      httpClient: client,
      logger: mockLogger(),
    });

    // First poll at 2s, second at 4s (past 3s deadline)
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe('expired');
  });

  it('returns expired response from server', async () => {
    const client = mockHttpClientWithResponses([{ status: 'expired' }]);

    const promise = pollForApproval({
      cloudUrl: 'https://api.generacy.ai',
      deviceCode: 'dc-123',
      interval: 1,
      expiresIn: 60,
      httpClient: client,
      logger: mockLogger(),
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.status).toBe('expired');
  });
});
