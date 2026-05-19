import { describe, it, expect, vi } from 'vitest';
import { initDeviceFlow, pollDeviceCode } from '../../src/client.js';
import { ActivationError } from '../../src/errors.js';
import type { HttpClient, HttpResponse } from '../../src/types.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function mockHttpClient(responses: Array<HttpResponse<unknown>>): HttpClient {
  let callIndex = 0;
  return {
    post: vi.fn(async () => {
      const resp = responses[callIndex++];
      if (!resp) throw new Error('No more mock responses');
      return resp;
    }),
  };
}

describe('initDeviceFlow', () => {
  it('returns device code response on success', async () => {
    const deviceCodeData = {
      device_code: 'dc-123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://generacy.ai/activate',
      interval: 5,
      expires_in: 300,
    };
    const client = mockHttpClient([{ status: 200, data: deviceCodeData }]);
    const result = await initDeviceFlow('https://api.generacy.ai', client, mockLogger(), 0);
    expect(result).toEqual(deviceCodeData);
  });

  it('retries on network error and succeeds', async () => {
    const deviceCodeData = {
      device_code: 'dc-456',
      user_code: 'EFGH-5678',
      verification_uri: 'https://generacy.ai/activate',
      interval: 5,
      expires_in: 300,
    };
    const client: HttpClient = {
      post: vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ status: 200, data: deviceCodeData }),
    };
    const result = await initDeviceFlow('https://api.generacy.ai', client, mockLogger(), 1);
    expect(result).toEqual(deviceCodeData);
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it('throws CLOUD_UNREACHABLE after max retries', async () => {
    const client: HttpClient = {
      post: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    await expect(
      initDeviceFlow('https://api.generacy.ai', client, mockLogger(), 1),
    ).rejects.toThrow(ActivationError);
    await expect(
      initDeviceFlow('https://api.generacy.ai', client, mockLogger(), 1),
    ).rejects.toMatchObject({ code: 'CLOUD_UNREACHABLE' });
  });

  it('throws INVALID_RESPONSE on bad schema', async () => {
    const client = mockHttpClient([{ status: 200, data: { bad: 'data' } }]);
    await expect(
      initDeviceFlow('https://api.generacy.ai', client, mockLogger(), 0),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('pollDeviceCode', () => {
  it('returns approved response', async () => {
    const approved = {
      status: 'approved' as const,
      cluster_api_key: 'key-123',
      cluster_api_key_id: 'kid-123',
      cluster_id: 'cl-123',
      project_id: 'pj-123',
      org_id: 'org-123',
      cloud_url: 'https://api.generacy.ai',
    };
    const client = mockHttpClient([{ status: 200, data: approved }]);
    const result = await pollDeviceCode('https://api.generacy.ai', 'dc-123', client);
    expect(result).toEqual(approved);
  });

  it('returns pending response', async () => {
    const pending = { status: 'authorization_pending' };
    const client = mockHttpClient([{ status: 200, data: pending }]);
    const result = await pollDeviceCode('https://api.generacy.ai', 'dc-123', client);
    expect(result).toEqual(pending);
  });

  it('throws INVALID_RESPONSE on bad data', async () => {
    const client = mockHttpClient([{ status: 200, data: { status: 'unknown' } }]);
    await expect(
      pollDeviceCode('https://api.generacy.ai', 'dc-123', client),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
