import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveApiUrl } from '../cloud-url.js';

describe('resolveApiUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the flag value when provided', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://env.example.com');
    expect(resolveApiUrl('https://flag.example.com')).toBe('https://flag.example.com');
  });

  it('reads GENERACY_API_URL when no flag provided', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://new-api.example.com');
    expect(resolveApiUrl()).toBe('https://new-api.example.com');
  });

  it('returns default when GENERACY_API_URL is not set', () => {
    delete process.env['GENERACY_API_URL'];
    expect(resolveApiUrl()).toBe('https://api.generacy.ai');
  });

  it('CLI flag takes precedence over GENERACY_API_URL', () => {
    vi.stubEnv('GENERACY_API_URL', 'https://api.example.com');
    expect(resolveApiUrl('https://staging.generacy.ai')).toBe('https://staging.generacy.ai');
  });

  it('throws on invalid URL from flag', () => {
    expect(() => resolveApiUrl('not-a-url')).toThrow('Invalid cloud URL "not-a-url"');
  });

  it('throws on invalid URL from env var', () => {
    vi.stubEnv('GENERACY_API_URL', 'bad-url');
    expect(() => resolveApiUrl()).toThrow('Invalid cloud URL "bad-url"');
  });

  it('does not read GENERACY_CLOUD_URL (old var is not honored)', () => {
    delete process.env['GENERACY_API_URL'];
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://old-cloud.example.com');
    expect(resolveApiUrl()).toBe('https://api.generacy.ai');
  });
});
