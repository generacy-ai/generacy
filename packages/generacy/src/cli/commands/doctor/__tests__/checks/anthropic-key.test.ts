import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CheckContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock: global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    configPath: null,
    config: null,
    envVars: null,
    inDevContainer: false,
    verbose: false,
    projectRoot: null,
    ...overrides,
  };
}

function makeResponse(options: {
  status?: number;
  ok?: boolean;
  body?: object | string;
}): Response {
  const {
    status = 200,
    ok = status >= 200 && status < 300,
    body = {},
  } = options;
  return {
    status,
    ok,
    headers: new Headers(),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('anthropicKeyCheck', () => {
  let anthropicKeyCheck: (typeof import('../../checks/anthropic-key.js'))['anthropicKeyCheck'];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    const mod = await import('../../checks/anthropic-key.js');
    anthropicKeyCheck = mod.anthropicKeyCheck;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(anthropicKeyCheck.id).toBe('anthropic-key');
    expect(anthropicKeyCheck.category).toBe('credentials');
    expect(anthropicKeyCheck.dependencies).toEqual(['env-file']);
    expect(anthropicKeyCheck.priority).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // Skip: no envVars in context
  // -------------------------------------------------------------------------

  it('skips when envVars is null', async () => {
    const result = await anthropicKeyCheck.run(
      makeContext({ envVars: null }),
    );

    expect(result.status).toBe('skip');
    expect(result.message).toContain('env vars not available');
  });

  // -------------------------------------------------------------------------
  // Failure: key not set
  // -------------------------------------------------------------------------

  it('fails when ANTHROPIC_API_KEY is missing from envVars', async () => {
    const result = await anthropicKeyCheck.run(
      makeContext({ envVars: { GITHUB_TOKEN: 'tok' } }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('ANTHROPIC_API_KEY is not set');
    expect(result.suggestion).toContain('console.anthropic.com');
  });

  it('fails when ANTHROPIC_API_KEY is empty', async () => {
    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: '  ' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('ANTHROPIC_API_KEY is not set');
  });

  // -------------------------------------------------------------------------
  // Failure: 401 unauthorized
  // -------------------------------------------------------------------------

  it('fails with invalid key on 401', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 401,
        body: { error: { message: 'Invalid API key' } },
      }),
    );

    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-bad' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toBe('Anthropic API key is invalid');
    expect(result.suggestion).toContain('console.anthropic.com');
  });

  // -------------------------------------------------------------------------
  // Failure: non-401 HTTP error
  // -------------------------------------------------------------------------

  it('fails with HTTP error for non-401 error response', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 500, body: 'Internal Server Error' }),
    );

    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('HTTP 500');
  });

  // -------------------------------------------------------------------------
  // Failure: timeout
  // -------------------------------------------------------------------------

  it('fails on timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    mockFetch.mockRejectedValue(timeoutError);

    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('timed out');
    expect(result.suggestion).toContain('network');
  });

  // -------------------------------------------------------------------------
  // Failure: network error
  // -------------------------------------------------------------------------

  it('fails on network error', async () => {
    mockFetch.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND api.anthropic.com'),
    );

    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to connect');
    expect(result.suggestion).toContain('network');
    expect(result.detail).toContain('ENOTFOUND');
  });

  // -------------------------------------------------------------------------
  // Success: valid API key
  // -------------------------------------------------------------------------

  it('passes with valid API key', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        body: { data: [{ id: 'claude-3' }] },
      }),
    );

    const result = await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-valid' },
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toBe('Anthropic API key is valid');
  });

  // -------------------------------------------------------------------------
  // Fetch call details
  // -------------------------------------------------------------------------

  it('calls fetch with correct URL and headers', async () => {
    mockFetch.mockResolvedValue(makeResponse({ status: 200 }));

    await anthropicKeyCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'tok', ANTHROPIC_API_KEY: 'sk-ant-mykey' },
      }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(options.headers['x-api-key']).toBe('sk-ant-mykey');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
  });
});
