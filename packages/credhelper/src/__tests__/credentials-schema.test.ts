import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CredentialsConfigSchema } from '../schemas/credentials.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return parse(readFileSync(resolve(fixturesDir, name), 'utf-8'));
}

describe('CredentialsConfigSchema', () => {
  it('parses the credentials fixture successfully', () => {
    const data = loadFixture('credentials.yaml');
    const result = CredentialsConfigSchema.parse(data);

    expect(result.schemaVersion).toBe('1');
    expect(result.credentials).toHaveLength(4);

    const github = result.credentials[0]!;
    expect(github.id).toBe('github-main-org');
    expect(github.type).toBe('github-app');
    expect(github.backend).toBe('generacy-cloud');
    expect(github.backendKey).toBe('github-apps/main-org');
    expect(github.mint).toEqual({
      ttl: '1h',
      scopeTemplate: { repositories: 'required', permissions: 'required' },
    });

    const stripe = result.credentials[2]!;
    expect(stripe.id).toBe('stripe-test');
    expect(stripe.mint).toBeUndefined();
  });

  it('parses the credentials-local overlay fixture', () => {
    const data = loadFixture('credentials-local.yaml');
    const result = CredentialsConfigSchema.parse(data);

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]!.id).toBe('github-main-org');
    expect(result.credentials[0]!.type).toBe('github-pat');
    expect(result.credentials[0]!.backend).toBe('env');
  });

  it('rejects missing schemaVersion', () => {
    const data = { credentials: [{ id: 'x', type: 'y', backend: 'z', backendKey: 'k' }] };
    expect(() => CredentialsConfigSchema.parse(data)).toThrow();
  });

  it('rejects credential missing id', () => {
    const data = {
      schemaVersion: '1',
      credentials: [{ type: 'y', backend: 'z', backendKey: 'k' }],
    };
    expect(() => CredentialsConfigSchema.parse(data)).toThrow();
  });

  it('rejects credential missing backend', () => {
    const data = {
      schemaVersion: '1',
      credentials: [{ id: 'x', type: 'y', backendKey: 'k' }],
    };
    expect(() => CredentialsConfigSchema.parse(data)).toThrow();
  });

  it('rejects credential missing backendKey', () => {
    const data = {
      schemaVersion: '1',
      credentials: [{ id: 'x', type: 'y', backend: 'z' }],
    };
    expect(() => CredentialsConfigSchema.parse(data)).toThrow();
  });

  it('rejects mint with missing ttl', () => {
    const data = {
      schemaVersion: '1',
      credentials: [{
        id: 'x', type: 'y', backend: 'z', backendKey: 'k',
        mint: { scopeTemplate: {} },
      }],
    };
    expect(() => CredentialsConfigSchema.parse(data)).toThrow();
  });
});
