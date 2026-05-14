import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  refreshGhAuth,
  extractGhToken,
} from '../../src/services/gh-auth-refresh.js';

const mockedExecFile = vi.mocked(execFile);

describe('refreshGhAuth', () => {
  let stdinWrite: ReturnType<typeof vi.fn>;
  let stdinEnd: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdinWrite = vi.fn();
    stdinEnd = vi.fn();
  });

  function setupExecFile(error: Error | null) {
    mockedExecFile.mockImplementation(
      ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (error: Error | null) => void;
        // Call the callback asynchronously to mimic real behavior
        process.nextTick(() => callback(error));
        return {
          stdin: { write: stdinWrite, end: stdinEnd },
        } as unknown as ChildProcess;
      }) as typeof execFile,
    );
  }

  it('returns { ok: true } when execFile succeeds', async () => {
    setupExecFile(null);

    const result = await refreshGhAuth('ghs_test_token');

    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: false, error } when execFile fails', async () => {
    setupExecFile(new Error('gh not found'));

    const result = await refreshGhAuth('ghs_test_token');

    expect(result).toEqual({ ok: false, error: 'gh not found' });
  });

  it('passes token via stdin, not via argv', async () => {
    setupExecFile(null);

    await refreshGhAuth('ghs_secret_token');

    // Token must be written to stdin
    expect(stdinWrite).toHaveBeenCalledWith('ghs_secret_token');
    expect(stdinEnd).toHaveBeenCalled();

    // Token must NOT appear in argv (args array)
    const args = mockedExecFile.mock.calls[0]![1] as string[];
    expect(args).not.toContain('ghs_secret_token');
  });

  it('args include --with-token and --hostname github.com', async () => {
    setupExecFile(null);

    await refreshGhAuth('ghs_test_token');

    const args = mockedExecFile.mock.calls[0]![1] as string[];
    expect(args).toContain('--with-token');
    expect(args).toContain('--hostname');
    expect(args).toContain('github.com');
  });
});

describe('extractGhToken', () => {
  it('extracts token from github-app JSON value', () => {
    const result = extractGhToken(
      'github-app',
      '{"installationId":1,"token":"ghs_abc"}',
    );
    expect(result).toBe('ghs_abc');
  });

  it('returns raw string for github-pat', () => {
    const result = extractGhToken('github-pat', 'ghp_pat123');
    expect(result).toBe('ghp_pat123');
  });

  it('returns null for non-github types', () => {
    expect(extractGhToken('api-key', 'sk-ant-xyz')).toBeNull();
    expect(extractGhToken('aws-sts', 'some-value')).toBeNull();
    expect(extractGhToken('stripe-restricted-key', 'rk_live_xxx')).toBeNull();
  });

  it('returns null for malformed JSON in github-app', () => {
    const result = extractGhToken('github-app', 'not-valid-json');
    expect(result).toBeNull();
  });

  it('returns null when github-app JSON is missing the token field', () => {
    const result = extractGhToken('github-app', '{"installationId":1}');
    expect(result).toBeNull();
  });

  it('returns null for empty github-pat string', () => {
    const result = extractGhToken('github-pat', '');
    expect(result).toBeNull();
  });
});
