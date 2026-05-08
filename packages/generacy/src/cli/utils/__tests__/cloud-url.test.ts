import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveApiUrl, resolveCloudUrl } from '../cloud-url.js';

describe('resolveApiUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the flag value when provided', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://env.example.com');
    expect(resolveApiUrl('https://flag.example.com')).toBe('https://flag.example.com');
  });

  it('GENERACY_API_URL takes precedence over GENERACY_CLOUD_URL', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://new-api.example.com');
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://old-cloud.example.com');
    expect(resolveApiUrl()).toBe('https://new-api.example.com');
  });

  it('falls back to GENERACY_CLOUD_URL when GENERACY_API_URL absent', () => {
    delete process.env['GENERACY_API_URL'];
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://old-cloud.example.com');
    expect(resolveApiUrl()).toBe('https://old-cloud.example.com');
  });

  it('returns default when neither env var is set', () => {
    delete process.env['GENERACY_API_URL'];
    delete process.env['GENERACY_CLOUD_URL'];
    expect(resolveApiUrl()).toBe('https://api.generacy.ai');
  });

  it('CLI flag takes precedence over both env vars', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://api.example.com');
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://cloud.example.com');
    expect(resolveApiUrl('https://staging.generacy.ai')).toBe('https://staging.generacy.ai');
  });

  it('throws on invalid URL from flag', () => {
    expect(() => resolveApiUrl('not-a-url')).toThrow('Invalid cloud URL "not-a-url"');
  });

  it('throws on invalid URL from env var', () => {
    vi.stubEnv('GENERACY_API_URL', 'bad-url');
    expect(() => resolveApiUrl()).toThrow('Invalid cloud URL "bad-url"');
  });
});

describe('resolveCloudUrl (deprecated alias)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('is an alias for resolveApiUrl', () => {
    expect(resolveCloudUrl).toBe(resolveApiUrl);
  });
});
