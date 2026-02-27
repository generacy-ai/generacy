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
  headers?: Record<string, string>;
  body?: object | string;
}): Response {
  const {
    status = 200,
    ok = status >= 200 && status < 300,
    headers = {},
    body = {},
  } = options;
  return {
    status,
    ok,
    headers: new Headers(headers),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('githubTokenCheck', () => {
  let githubTokenCheck: (typeof import('../../checks/github-token.js'))['githubTokenCheck'];

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    // Re-import to pick up the mocked fetch
    const mod = await import('../../checks/github-token.js');
    githubTokenCheck = mod.githubTokenCheck;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('has correct metadata', () => {
    expect(githubTokenCheck.id).toBe('github-token');
    expect(githubTokenCheck.category).toBe('credentials');
    expect(githubTokenCheck.dependencies).toEqual(['env-file']);
    expect(githubTokenCheck.priority).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // Skip: no envVars in context
  // -------------------------------------------------------------------------

  it('skips when envVars is null', async () => {
    const result = await githubTokenCheck.run(
      makeContext({ envVars: null }),
    );

    expect(result.status).toBe('skip');
    expect(result.message).toContain('env vars not available');
  });

  // -------------------------------------------------------------------------
  // Failure: token not set
  // -------------------------------------------------------------------------

  it('fails when GITHUB_TOKEN is missing from envVars', async () => {
    const result = await githubTokenCheck.run(
      makeContext({ envVars: { ANTHROPIC_API_KEY: 'key' } }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('GITHUB_TOKEN is not set');
    expect(result.suggestion).toContain('github.com/settings/tokens');
  });

  it('fails when GITHUB_TOKEN is empty', async () => {
    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: '  ', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('GITHUB_TOKEN is not set');
  });

  // -------------------------------------------------------------------------
  // Failure: 401 unauthorized
  // -------------------------------------------------------------------------

  it('fails with invalid token on 401', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 401, body: { message: 'Bad credentials' } }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_invalid', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toBe('GitHub token is invalid');
    expect(result.suggestion).toContain('Generate a new');
  });

  // -------------------------------------------------------------------------
  // Failure: non-401 HTTP error
  // -------------------------------------------------------------------------

  it('fails with HTTP error for non-401 error response', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ status: 500, body: 'Internal Server Error' }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_token', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('HTTP 500');
  });

  // -------------------------------------------------------------------------
  // Warning: missing scopes
  // -------------------------------------------------------------------------

  it('warns when token is valid but missing required scopes', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        headers: { 'x-oauth-scopes': 'read:org, user' },
        body: { login: 'testuser' },
      }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_valid', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing scopes');
    expect(result.message).toContain('repo');
    expect(result.message).toContain('workflow');
    expect(result.suggestion).toContain('repo');
    expect(result.suggestion).toContain('workflow');
  });

  it('warns when token has only one required scope', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org' },
        body: { login: 'testuser' },
      }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_valid', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('warn');
    expect(result.message).toContain('workflow');
    expect(result.message).not.toContain('repo,');
  });

  // -------------------------------------------------------------------------
  // Failure: timeout
  // -------------------------------------------------------------------------

  it('fails on timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    mockFetch.mockRejectedValue(timeoutError);

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_valid', ANTHROPIC_API_KEY: 'key' },
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
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_valid', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('Failed to connect');
    expect(result.suggestion).toContain('network');
    expect(result.detail).toContain('ENOTFOUND');
  });

  // -------------------------------------------------------------------------
  // Success: valid token with all scopes
  // -------------------------------------------------------------------------

  it('passes with valid token and all required scopes', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, workflow, read:org' },
        body: { login: 'testuser' },
      }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_valid', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('valid');
    expect(result.message).toContain('testuser');
    expect(result.detail).toContain('repo');
    expect(result.detail).toContain('workflow');
  });

  // -------------------------------------------------------------------------
  // Success: fine-grained token (no X-OAuth-Scopes header)
  // -------------------------------------------------------------------------

  it('passes with fine-grained token (no scopes header)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        // No x-oauth-scopes header
        headers: {},
        body: { login: 'fineuser' },
      }),
    );

    const result = await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'github_pat_fine', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('valid');
    expect(result.message).toContain('fineuser');
    expect(result.detail).toContain('Fine-grained');
  });

  // -------------------------------------------------------------------------
  // Fetch call details
  // -------------------------------------------------------------------------

  it('calls fetch with correct URL and headers', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, workflow' },
        body: { login: 'testuser' },
      }),
    );

    await githubTokenCheck.run(
      makeContext({
        envVars: { GITHUB_TOKEN: 'ghp_mytoken', ANTHROPIC_API_KEY: 'key' },
      }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(options.headers.Authorization).toBe('Bearer ghp_mytoken');
  });
});
