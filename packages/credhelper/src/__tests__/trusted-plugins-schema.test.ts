import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrustedPluginsSchema } from '../schemas/trusted-plugins.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return parse(readFileSync(resolve(fixturesDir, name), 'utf-8'));
}

describe('TrustedPluginsSchema', () => {
  it('parses the trusted-plugins fixture successfully', () => {
    const data = loadFixture('trusted-plugins.yaml');
    const result = TrustedPluginsSchema.parse(data);

    expect(result.schemaVersion).toBe('1');
    expect(result.plugins['github-app']).toBeDefined();
    expect(result.plugins['github-app']!.sha256).toBe(
      'abc123def456789012345678901234567890123456789012345678901234abcd',
    );
    expect(result.plugins['gcp-service-account']).toBeDefined();
  });

  it('rejects missing schemaVersion', () => {
    const data = { plugins: { test: { sha256: 'abc' } } };
    expect(() => TrustedPluginsSchema.parse(data)).toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    const data = { schemaVersion: '2', plugins: {} };
    expect(() => TrustedPluginsSchema.parse(data)).toThrow();
  });

  it('rejects plugin entry missing sha256', () => {
    const data = {
      schemaVersion: '1',
      plugins: { test: {} },
    };
    expect(() => TrustedPluginsSchema.parse(data)).toThrow();
  });

  it('accepts empty plugins record', () => {
    const data = { schemaVersion: '1', plugins: {} };
    const result = TrustedPluginsSchema.parse(data);
    expect(Object.keys(result.plugins)).toHaveLength(0);
  });
});
