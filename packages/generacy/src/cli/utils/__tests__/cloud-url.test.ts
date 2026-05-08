import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCloudUrl } from '../cloud-url.js';

describe('resolveCloudUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the flag value when provided', () => {
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://env.example.com');
    expect(resolveCloudUrl('https://flag.example.com')).toBe('https://flag.example.com');
  });

  it('returns env var when no flag is provided', () => {
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://env.example.com');
    expect(resolveCloudUrl()).toBe('https://env.example.com');
    expect(resolveCloudUrl(undefined)).toBe('https://env.example.com');
  });

  it('returns default when neither flag nor env var is set', () => {
    delete process.env['GENERACY_CLOUD_URL'];
    expect(resolveCloudUrl()).toBe('https://api.generacy.ai');
  });

  it('flag overrides both env var and default', () => {
    vi.stubEnv('GENERACY_CLOUD_URL', 'https://env.example.com');
    expect(resolveCloudUrl('https://staging.generacy.ai')).toBe('https://staging.generacy.ai');
  });

  it('throws on invalid URL from flag', () => {
    expect(() => resolveCloudUrl('not-a-url')).toThrow('Invalid cloud URL "not-a-url"');
  });

  it('throws on invalid URL from env var', () => {
    vi.stubEnv('GENERACY_CLOUD_URL', 'bad-url');
    expect(() => resolveCloudUrl()).toThrow('Invalid cloud URL "bad-url"');
  });
});
