import { describe, expect, it, vi } from 'vitest';
import { discoverChannelUrl } from '../channel-discovery.js';

function makeFs(
  behavior: 'valid' | 'enoent' | 'malformed' | 'non-smee' | 'error',
  value?: string,
): { readFile: (path: string, encoding: BufferEncoding) => Promise<string> } {
  return {
    readFile: async () => {
      if (behavior === 'enoent') {
        const err = new Error('file not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      if (behavior === 'error') {
        const err = new Error('perm denied') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      }
      if (behavior === 'malformed') return 'not a url at all';
      if (behavior === 'non-smee') return 'https://not-smee.example.com/foo';
      return value ?? 'https://smee.io/xyz789\n';
    },
  };
}

const FILE_PATH = '/tmp/generacy-doorbell-test-smee-channel';

describe('discoverChannelUrl', () => {
  it('returns env URL when env is set and matches pattern', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/abc123' },
      channelFilePath: FILE_PATH,
      fs: makeFs('enoent'),
      logger: { warn },
    });
    expect(result).toEqual({ url: 'https://smee.io/abc123', source: 'env' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('trims file content and returns file URL when env unset', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs('valid'),
      logger: { warn },
    });
    expect(result).toEqual({ url: 'https://smee.io/xyz789', source: 'file' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null silently when env unset and file ENOENT', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs('enoent'),
      logger: { warn },
    });
    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls through to file when env is invalid and file is valid', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'not-a-url' },
      channelFilePath: FILE_PATH,
      fs: makeFs('valid', 'https://smee.io/xyz789'),
      logger: { warn },
    });
    expect(result).toEqual({ url: 'https://smee.io/xyz789', source: 'file' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null with one warn when file content is malformed', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs('malformed'),
      logger: { warn },
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null with one warn when file has non-smee URL', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs('non-smee'),
      logger: { warn },
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns when env has trailing whitespace (regex mismatch)', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/abc123 ' },
      channelFilePath: FILE_PATH,
      fs: makeFs('enoent'),
      logger: { warn },
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null with one warn on non-ENOENT filesystem error', async () => {
    const warn = vi.fn();
    const result = await discoverChannelUrl({
      env: {},
      channelFilePath: FILE_PATH,
      fs: makeFs('error'),
      logger: { warn },
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
