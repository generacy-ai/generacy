import { describe, it, expect, vi } from 'vitest';
import { requestDeviceCode, pollDeviceCode } from '../client.js';
import type { HttpClient, HttpResponse } from '../types.js';
import { ActivationError } from '../errors.js';
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

function createMockHttpClient(responses: Array<() => HttpResponse<unknown> | Promise<HttpResponse<unknown>>>): HttpClient {
  let callIndex = 0;
  return {
    post: vi.fn(async () => {
      const responseFn = responses[callIndex++];
      if (!responseFn) throw new Error('No more mock responses');
      return responseFn();
    }),
  };
}

describe('requestDeviceCode', () => {
  it('returns a valid device code response on success', async () => {
    const mockResponse = {
      device_code: 'dc_test123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://generacy.ai/cluster-activate',
      interval: 5,
      expires_in: 900,
    };

    const client = createMockHttpClient([
      () => ({ status: 200, data: mockResponse }),
    ]);
    const logger = createMockLogger();

    const result = await requestDeviceCode('https://api.generacy.ai', client, logger, 5);

    expect(result).toEqual(mockResponse);
    expect(client.post).toHaveBeenCalledWith('https://api.generacy.ai/api/clusters/device-code');
  });

  it('retries on network failure up to maxRetries', async () => {
    const mockResponse = {
      device_code: 'dc_test123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://generacy.ai/cluster-activate',
      interval: 5,
      expires_in: 900,
    };

    const client = createMockHttpClient([
      () => { throw new Error('ECONNREFUSED'); },
      () => { throw new Error('ECONNREFUSED'); },
      () => ({ status: 200, data: mockResponse }),
    ]);
    const logger = createMockLogger();

    const result = await requestDeviceCode('https://api.generacy.ai', client, logger, 5);

    expect(result).toEqual(mockResponse);
    expect(client.post).toHaveBeenCalledTimes(3);
  });

  it('throws CLOUD_UNREACHABLE after all retries exhausted', async () => {
    const client = createMockHttpClient([
      () => { throw new Error('ECONNREFUSED'); },
      () => { throw new Error('ECONNREFUSED'); },
      () => { throw new Error('ECONNREFUSED'); },
    ]);
    const logger = createMockLogger();

    await expect(
      requestDeviceCode('https://api.generacy.ai', client, logger, 2),
    ).rejects.toThrow(ActivationError);

    try {
      await requestDeviceCode('https://api.generacy.ai', client, logger, 2);
    } catch (error) {
      expect((error as ActivationError).code).toBe('CLOUD_UNREACHABLE');
    }
  });

  it('throws INVALID_RESPONSE on Zod validation failure', async () => {
    const client = createMockHttpClient([
      () => ({ status: 200, data: { invalid: 'response' } }),
    ]);
    const logger = createMockLogger();

    await expect(
      requestDeviceCode('https://api.generacy.ai', client, logger, 5),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('pollDeviceCode', () => {
  it('returns parsed poll response on success', async () => {
    const mockResponse = { status: 'authorization_pending' };

    const client = createMockHttpClient([
      () => ({ status: 200, data: mockResponse }),
    ]);

    const result = await pollDeviceCode('https://api.generacy.ai', 'dc_test', client);

    expect(result).toEqual(mockResponse);
    expect(client.post).toHaveBeenCalledWith(
      'https://api.generacy.ai/api/clusters/device-code/poll',
      { device_code: 'dc_test' },
    );
  });

  it('throws INVALID_RESPONSE on invalid poll data', async () => {
    const client = createMockHttpClient([
      () => ({ status: 200, data: { status: 'unknown_status' } }),
    ]);

    await expect(
      pollDeviceCode('https://api.generacy.ai', 'dc_test', client),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
