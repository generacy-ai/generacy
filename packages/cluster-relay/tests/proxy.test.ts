import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiRequestMessage } from '../src/messages.js';
import type { RelayConfig } from '../src/config.js';
import { handleApiRequest } from '../src/proxy.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const baseConfig: RelayConfig = {
  apiKey: 'test-key',
  relayUrl: 'wss://api.generacy.ai/relay',
  orchestratorUrl: 'http://localhost:3000',
  requestTimeoutMs: 5000,
  heartbeatIntervalMs: 30000,
  baseReconnectDelayMs: 5000,
  maxReconnectDelayMs: 300000,
  routes: [],
};

const baseRequest: ApiRequestMessage = {
  type: 'api_request',
  correlationId: 'req-1',
  method: 'GET',
  path: '/workflows',
};

function createMockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Response {
  const headersObj = new Headers(headers);
  return {
    status,
    headers: headersObj,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('handleApiRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns api_response with status 200 and JSON body on successful proxy', async () => {
    const responseBody = { workflows: [{ id: 'wf-1', name: 'Test' }] };
    mockFetch.mockResolvedValue(createMockResponse(200, responseBody));

    const result = await handleApiRequest(baseRequest, baseConfig);

    expect(result).toEqual({
      type: 'api_response',
      correlationId: 'req-1',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: responseBody,
    });
  });

  it('returns api_response with status 502 on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await handleApiRequest(baseRequest, baseConfig);

    expect(result.type).toBe('api_response');
    expect(result.correlationId).toBe('req-1');
    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      error: 'Bad Gateway',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('returns api_response with status 504 on timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted', 'TimeoutError');
    mockFetch.mockRejectedValue(timeoutError);

    const result = await handleApiRequest(baseRequest, baseConfig);

    expect(result).toEqual({
      type: 'api_response',
      correlationId: 'req-1',
      status: 504,
      body: { error: 'Gateway Timeout', message: 'Request to orchestrator timed out' },
    });
  });

  it('includes X-API-Key header when orchestratorApiKey is set', async () => {
    const configWithApiKey: RelayConfig = {
      ...baseConfig,
      orchestratorApiKey: 'orch-secret-key',
    };
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(baseRequest, configWithApiKey);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers['X-API-Key']).toBe('orch-secret-key');
  });

  it('does not include X-API-Key header when orchestratorApiKey is not set', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(baseRequest, baseConfig);

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers).not.toHaveProperty('X-API-Key');
  });

  it('forwards POST request body as JSON.stringify in fetch call', async () => {
    const requestBody = { name: 'new-workflow', config: { steps: 3 } };
    const postRequest: ApiRequestMessage = {
      type: 'api_request',
      correlationId: 'req-1',
      method: 'POST',
      path: '/workflows',
      body: requestBody,
    };
    mockFetch.mockResolvedValue(createMockResponse(201, { id: 'wf-new' }));

    await handleApiRequest(postRequest, baseConfig);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:3000/workflows');
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].body).toBe(JSON.stringify(requestBody));
  });

  it('does not set body in fetch when request body is undefined', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(baseRequest, baseConfig);

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].body).toBeUndefined();
  });

  it('includes response headers from fetch in api_response', async () => {
    const responseHeaders = {
      'content-type': 'application/json',
      'x-request-id': 'abc-123',
      'x-ratelimit-remaining': '99',
    };
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }, responseHeaders));

    const result = await handleApiRequest(baseRequest, baseConfig);

    expect(result.headers).toEqual(responseHeaders);
  });

  it('constructs the correct URL from config and request path', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(baseRequest, baseConfig);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/workflows',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes request headers through to fetch', async () => {
    const requestWithHeaders: ApiRequestMessage = {
      ...baseRequest,
      headers: { 'Authorization': 'Bearer token', 'Accept': 'application/json' },
    };
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(requestWithHeaders, baseConfig);

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers['Authorization']).toBe('Bearer token');
    expect(callArgs[1].headers['Accept']).toBe('application/json');
  });

  it('reads text body when content-type is not application/json', async () => {
    const textBody = 'plain text response';
    const response = {
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve(textBody),
    } as unknown as Response;
    mockFetch.mockResolvedValue(response);

    const result = await handleApiRequest(baseRequest, baseConfig);

    expect(result.status).toBe(200);
    expect(result.body).toBe('plain text response');
  });

  it('routes to matched HTTP target with prefix stripping', async () => {
    const configWithRoutes: RelayConfig = {
      ...baseConfig,
      routes: [{ prefix: '/monitoring', target: 'http://localhost:9090' }],
    };
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    await handleApiRequest(
      { ...baseRequest, path: '/monitoring/metrics' },
      configWithRoutes,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:9090/metrics');
  });

  it('falls back to orchestratorUrl when no route matches', async () => {
    const configWithRoutes: RelayConfig = {
      ...baseConfig,
      routes: [{ prefix: '/monitoring', target: 'http://localhost:9090' }],
    };
    mockFetch.mockResolvedValue(createMockResponse(200, { ok: true }));

    await handleApiRequest(
      { ...baseRequest, path: '/workflows' },
      configWithRoutes,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:3000/workflows');
  });

  it('sets actor headers when actor is present', async () => {
    const requestWithActor: ApiRequestMessage = {
      ...baseRequest,
      actor: { userId: 'user-1', sessionId: 'sess-1' },
    };
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(requestWithActor, baseConfig);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers['x-generacy-actor-user-id']).toBe('user-1');
    expect(callArgs[1].headers['x-generacy-actor-session-id']).toBe('sess-1');
  });

  it('omits actor headers when actor is absent', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(baseRequest, baseConfig);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers).not.toHaveProperty('x-generacy-actor-user-id');
    expect(callArgs[1].headers).not.toHaveProperty('x-generacy-actor-session-id');
  });

  it('sets actor user-id header without session-id when sessionId is absent', async () => {
    const requestWithPartialActor: ApiRequestMessage = {
      ...baseRequest,
      actor: { userId: 'user-1' },
    };
    mockFetch.mockResolvedValue(createMockResponse(200, {}));

    await handleApiRequest(requestWithPartialActor, baseConfig);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers['x-generacy-actor-user-id']).toBe('user-1');
    expect(callArgs[1].headers).not.toHaveProperty('x-generacy-actor-session-id');
  });
});
