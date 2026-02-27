import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InitOptions, RepoAccessResult } from '../types.js';

// ---------------------------------------------------------------------------
// Mock execSafe — used by discoverGitHubToken for `gh auth token`
// ---------------------------------------------------------------------------

vi.mock('../../../utils/exec.js', () => ({
  execSafe: vi.fn(),
}));

import { execSafe } from '../../../utils/exec.js';
const mockExecSafe = vi.mocked(execSafe);

// ---------------------------------------------------------------------------
// Mock logger — suppress debug output during tests
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Mock @clack/prompts — capture warnings and spinner calls
// ---------------------------------------------------------------------------

const mockLogWarn = vi.fn();
const mockSpinnerStart = vi.fn();
const mockSpinnerStop = vi.fn();

vi.mock('@clack/prompts', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    info: vi.fn(),
    error: vi.fn(),
  },
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
  }),
}));

// ---------------------------------------------------------------------------
// Mock global fetch — used by validateRepoAccess
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  discoverGitHubToken,
  validateRepoAccess,
  runGitHubValidation,
} from '../github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal InitOptions with sensible defaults for testing. */
function makeOptions(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    projectId: null,
    projectName: 'test-project',
    primaryRepo: 'acme/app',
    devRepos: [],
    cloneRepos: [],
    agent: 'claude-code',
    baseBranch: 'main',
    releaseStream: 'stable',
    force: false,
    dryRun: false,
    skipGithubCheck: false,
    yes: false,
    verbose: false,
    ...overrides,
  };
}

/** Create a mock Response object for fetch. */
function mockResponse(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    statusText: '',
    type: 'basic',
    url: '',
    clone: () => mockResponse(status, body),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

// ---------------------------------------------------------------------------
// discoverGitHubToken
// ---------------------------------------------------------------------------

describe('discoverGitHubToken', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    mockExecSafe.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_TOKEN = originalEnv;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('returns GITHUB_TOKEN env var when set', () => {
    process.env.GITHUB_TOKEN = 'ghp_envtoken123';
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_clitoken456', stderr: '' });

    expect(discoverGitHubToken()).toBe('ghp_envtoken123');
    // Should NOT call gh auth token when env var is available
    expect(mockExecSafe).not.toHaveBeenCalled();
  });

  it('trims whitespace from GITHUB_TOKEN env var', () => {
    process.env.GITHUB_TOKEN = '  ghp_padded  ';

    expect(discoverGitHubToken()).toBe('ghp_padded');
  });

  it('falls back to gh auth token when GITHUB_TOKEN is not set', () => {
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_clitoken456', stderr: '' });

    expect(discoverGitHubToken()).toBe('ghp_clitoken456');
    expect(mockExecSafe).toHaveBeenCalledWith('gh auth token');
  });

  it('falls back to gh auth token when GITHUB_TOKEN is empty', () => {
    process.env.GITHUB_TOKEN = '';
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_clitoken456', stderr: '' });

    expect(discoverGitHubToken()).toBe('ghp_clitoken456');
    expect(mockExecSafe).toHaveBeenCalledWith('gh auth token');
  });

  it('falls back to gh auth token when GITHUB_TOKEN is whitespace-only', () => {
    process.env.GITHUB_TOKEN = '   ';
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_clitoken456', stderr: '' });

    expect(discoverGitHubToken()).toBe('ghp_clitoken456');
  });

  it('returns null when neither env var nor gh CLI available', () => {
    mockExecSafe.mockReturnValue({ ok: false, stdout: '', stderr: 'gh: not found' });

    expect(discoverGitHubToken()).toBeNull();
  });

  it('returns null when gh auth token returns empty stdout', () => {
    mockExecSafe.mockReturnValue({ ok: true, stdout: '', stderr: '' });

    expect(discoverGitHubToken()).toBeNull();
  });

  it('prioritizes GITHUB_TOKEN over gh auth token', () => {
    process.env.GITHUB_TOKEN = 'ghp_envtoken';
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_clitoken', stderr: '' });

    const token = discoverGitHubToken();
    expect(token).toBe('ghp_envtoken');
    expect(mockExecSafe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateRepoAccess
// ---------------------------------------------------------------------------

describe('validateRepoAccess', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns accessible + writable for 200 with push=true', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { permissions: { push: true } }),
    );

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      { repo: 'acme/app', accessible: true, writable: true },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_token',
        }),
      }),
    );
  });

  it('returns accessible + read-only for 200 with push=false', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { permissions: { push: false } }),
    );

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      { repo: 'acme/app', accessible: true, writable: false },
    ]);
  });

  it('returns accessible + read-only when permissions.push is missing', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: {} }));

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      { repo: 'acme/app', accessible: true, writable: false },
    ]);
  });

  it('returns accessible + read-only when permissions object is missing', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      { repo: 'acme/app', accessible: true, writable: false },
    ]);
  });

  it('returns not accessible for 404 (not found)', async () => {
    mockFetch.mockResolvedValue(mockResponse(404));

    const results = await validateRepoAccess(['acme/private'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/private',
        accessible: false,
        writable: false,
        error: 'Repository not found or no access',
      },
    ]);
  });

  it('returns bad credentials error for 401', async () => {
    mockFetch.mockResolvedValue(mockResponse(401));

    const results = await validateRepoAccess(['acme/app'], 'ghp_expired');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/app',
        accessible: false,
        writable: false,
        error: 'Bad credentials (HTTP 401)',
      },
    ]);
  });

  it('returns bad credentials error for 403', async () => {
    mockFetch.mockResolvedValue(mockResponse(403));

    const results = await validateRepoAccess(['acme/app'], 'ghp_forbidden');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/app',
        accessible: false,
        writable: false,
        error: 'Bad credentials (HTTP 403)',
      },
    ]);
  });

  it('handles unexpected HTTP status codes', async () => {
    mockFetch.mockResolvedValue(mockResponse(500));

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/app',
        accessible: false,
        writable: false,
        error: 'Unexpected response (HTTP 500)',
      },
    ]);
  });

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/app',
        accessible: false,
        writable: false,
        error: 'fetch failed',
      },
    ]);
  });

  it('handles non-Error thrown values', async () => {
    mockFetch.mockRejectedValue('string error');

    const results = await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(results).toEqual<RepoAccessResult[]>([
      {
        repo: 'acme/app',
        accessible: false,
        writable: false,
        error: 'Network error',
      },
    ]);
  });

  it('validates multiple repos and returns results in order', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(mockResponse(404))
      .mockResolvedValueOnce(mockResponse(200, { permissions: { push: false } }));

    const results = await validateRepoAccess(
      ['acme/app', 'acme/missing', 'acme/readonly'],
      'ghp_token',
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ repo: 'acme/app', accessible: true, writable: true });
    expect(results[1]).toEqual({
      repo: 'acme/missing',
      accessible: false,
      writable: false,
      error: 'Repository not found or no access',
    });
    expect(results[2]).toEqual({ repo: 'acme/readonly', accessible: true, writable: false });
  });

  it('returns empty array for empty repos list', async () => {
    const results = await validateRepoAccess([], 'ghp_token');

    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends correct headers including User-Agent and Accept', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: true } }));

    await validateRepoAccess(['acme/app'], 'ghp_token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app',
      {
        headers: {
          Authorization: 'Bearer ghp_token',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'generacy-cli',
        },
      },
    );
  });
});

// ---------------------------------------------------------------------------
// runGitHubValidation
// ---------------------------------------------------------------------------

describe('runGitHubValidation', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    mockExecSafe.mockReset();
    mockFetch.mockReset();
    mockLogWarn.mockReset();
    mockSpinnerStart.mockReset();
    mockSpinnerStop.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_TOKEN = originalEnv;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('skips validation when skipGithubCheck is true', async () => {
    const options = makeOptions({ skipGithubCheck: true });

    await runGitHubValidation(options);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockSpinnerStart).not.toHaveBeenCalled();
  });

  it('warns and returns when no token is found', async () => {
    mockExecSafe.mockReturnValue({ ok: false, stdout: '', stderr: '' });
    const options = makeOptions();

    await runGitHubValidation(options);

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('GitHub validation skipped'),
    );
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('no credentials found'),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates primary repo, dev repos, and clone repos', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: true } }));

    const options = makeOptions({
      primaryRepo: 'acme/app',
      devRepos: ['acme/lib'],
      cloneRepos: ['acme/docs'],
    });

    await runGitHubValidation(options);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app',
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/lib',
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/docs',
      expect.any(Object),
    );
  });

  it('shows spinner during validation', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: true } }));

    const options = makeOptions();

    await runGitHubValidation(options);

    expect(mockSpinnerStart).toHaveBeenCalledWith(
      expect.stringContaining('Validating GitHub'),
    );
    expect(mockSpinnerStop).toHaveBeenCalledWith(
      expect.stringContaining('GitHub validation complete'),
    );
  });

  it('warns for inaccessible repos (does not throw)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch.mockResolvedValue(mockResponse(404));

    const options = makeOptions({ primaryRepo: 'acme/secret' });

    await runGitHubValidation(options);

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('"acme/secret"'),
    );
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('not accessible'),
    );
  });

  it('warns for read-only repos (does not throw)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: false } }));

    const options = makeOptions({ primaryRepo: 'acme/readonly' });

    await runGitHubValidation(options);

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('"acme/readonly"'),
    );
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('read-only'),
    );
  });

  it('does not warn for fully accessible repos', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: true } }));

    const options = makeOptions({ primaryRepo: 'acme/app' });

    await runGitHubValidation(options);

    // Only spinner start/stop should have been called, no warnings
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('warns for each problematic repo in a multi-repo setup', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { permissions: { push: true } })) // primary — ok
      .mockResolvedValueOnce(mockResponse(404)) // dev repo — not found
      .mockResolvedValueOnce(mockResponse(200, { permissions: { push: false } })); // clone — read-only

    const options = makeOptions({
      primaryRepo: 'acme/app',
      devRepos: ['acme/missing-lib'],
      cloneRepos: ['acme/readonly-docs'],
    });

    await runGitHubValidation(options);

    // Should have exactly 2 warnings: one for 404, one for read-only
    expect(mockLogWarn).toHaveBeenCalledTimes(2);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('"acme/missing-lib"'),
    );
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('"acme/readonly-docs"'),
    );
  });

  it('uses gh auth token fallback when env var is not set', async () => {
    mockExecSafe.mockReturnValue({ ok: true, stdout: 'ghp_fromcli', stderr: '' });
    mockFetch.mockResolvedValue(mockResponse(200, { permissions: { push: true } }));

    const options = makeOptions();

    await runGitHubValidation(options);

    expect(mockExecSafe).toHaveBeenCalledWith('gh auth token');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_fromcli',
        }),
      }),
    );
  });

  it('never aborts the init flow (advisory only)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    // All repos fail with various errors
    mockFetch
      .mockResolvedValueOnce(mockResponse(401))
      .mockResolvedValueOnce(mockResponse(404))
      .mockRejectedValueOnce(new Error('network down'));

    const options = makeOptions({
      primaryRepo: 'acme/app',
      devRepos: ['acme/lib'],
      cloneRepos: ['acme/docs'],
    });

    // Should resolve successfully (not throw) even when all repos fail
    await expect(runGitHubValidation(options)).resolves.toBeUndefined();
  });
});
