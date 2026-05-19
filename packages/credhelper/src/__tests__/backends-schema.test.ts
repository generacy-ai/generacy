import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackendsConfigSchema } from '../schemas/backends.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return parse(readFileSync(resolve(fixturesDir, name), 'utf-8'));
}

describe('BackendsConfigSchema', () => {
  it('parses the backends fixture successfully', () => {
    const data = loadFixture('backends.yaml');
    const result = BackendsConfigSchema.parse(data);

    expect(result.schemaVersion).toBe('1');
    expect(result.backends).toHaveLength(2);
    expect(result.backends[0]!.id).toBe('generacy-cloud');
    expect(result.backends[0]!.type).toBe('generacy-cloud');
    expect(result.backends[0]!.endpoint).toBe('https://api.generacy.com');
    expect(result.backends[0]!.auth).toEqual({ mode: 'oidc-device' });
    expect(result.backends[1]!.id).toBe('env');
    expect(result.backends[1]!.type).toBe('env');
  });

  it('allows passthrough fields in auth', () => {
    const data = {
      schemaVersion: '1',
      backends: [{
        id: 'vault',
        type: 'vault',
        auth: { mode: 'token', token: 'hvs.secret', namespace: 'prod' },
      }],
    };
    const result = BackendsConfigSchema.parse(data);
    expect(result.backends[0]!.auth).toEqual({
      mode: 'token',
      token: 'hvs.secret',
      namespace: 'prod',
    });
  });

  it('rejects missing schemaVersion', () => {
    const data = { backends: [{ id: 'x', type: 'y' }] };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    const data = { schemaVersion: '2', backends: [] };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });

  it('rejects backend entry missing id', () => {
    const data = {
      schemaVersion: '1',
      backends: [{ type: 'env' }],
    };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });

  it('rejects backend entry missing type', () => {
    const data = {
      schemaVersion: '1',
      backends: [{ id: 'env' }],
    };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });

  it('rejects invalid endpoint URL', () => {
    const data = {
      schemaVersion: '1',
      backends: [{ id: 'x', type: 'y', endpoint: 'not-a-url' }],
    };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });

  it('rejects auth without mode', () => {
    const data = {
      schemaVersion: '1',
      backends: [{ id: 'x', type: 'y', auth: { token: 'abc' } }],
    };
    expect(() => BackendsConfigSchema.parse(data)).toThrow();
  });
});
