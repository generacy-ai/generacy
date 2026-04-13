import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../config/loader.js';
import { ConfigValidationError } from '../config/errors.js';

let agencyDir: string;

function secretsDir() {
  return join(agencyDir, 'secrets');
}

function rolesDir() {
  return join(agencyDir, 'roles');
}

function writeYaml(filePath: string, data: unknown) {
  writeFileSync(filePath, stringify(data), 'utf-8');
}

function writeValidBackends() {
  writeYaml(join(secretsDir(), 'backends.yaml'), {
    schemaVersion: '1',
    backends: [
      { id: 'vault', type: 'vault' },
      { id: 'env', type: 'env' },
    ],
  });
}

function writeValidCredentials() {
  writeYaml(join(secretsDir(), 'credentials.yaml'), {
    schemaVersion: '1',
    credentials: [
      { id: 'gh-token', type: 'github-app', backend: 'vault', backendKey: 'gh/token' },
      { id: 'gcp-sa', type: 'gcp-service-account', backend: 'vault', backendKey: 'gcp/sa' },
    ],
  });
}

function writeValidRole(name: string, data: Record<string, unknown>) {
  writeYaml(join(rolesDir(), `${name}.yaml`), data);
}

beforeEach(() => {
  agencyDir = mkdtempSync(join(tmpdir(), 'credhelper-test-'));
  mkdirSync(secretsDir(), { recursive: true });
  mkdirSync(rolesDir(), { recursive: true });
});

afterEach(() => {
  rmSync(agencyDir, { recursive: true, force: true });
});

describe('loadConfig integration', () => {
  it('loads a full valid config directory successfully', () => {
    writeValidBackends();
    writeValidCredentials();
    writeValidRole('dev', {
      schemaVersion: '1',
      id: 'dev',
      description: 'Developer',
      credentials: [{ ref: 'gh-token', expose: [{ as: 'env', name: 'GH' }] }],
    });

    const result = loadConfig({ agencyDir });

    expect(result.backends.backends).toHaveLength(2);
    expect(result.credentials.credentials).toHaveLength(2);
    expect(result.roles.get('dev')).toBeDefined();
    expect(result.overlayIds).toEqual([]);
    expect(result.trustedPlugins).toBeNull();
  });

  it('fails when backends.yaml is missing', () => {
    writeValidCredentials();

    expect(() => loadConfig({ agencyDir })).toThrow(ConfigValidationError);
    try {
      loadConfig({ agencyDir });
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors.some((x) => x.message.includes('Required file not found'))).toBe(true);
    }
  });

  it('fails when credentials.yaml is missing', () => {
    writeValidBackends();

    expect(() => loadConfig({ agencyDir })).toThrow(ConfigValidationError);
    try {
      loadConfig({ agencyDir });
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors.some((x) => x.message.includes('Required file not found'))).toBe(true);
    }
  });

  it('succeeds when optional files are missing', () => {
    writeValidBackends();
    writeValidCredentials();
    // No trusted-plugins, no overlay, no roles directory needed
    rmSync(rolesDir(), { recursive: true, force: true });

    const result = loadConfig({ agencyDir });

    expect(result.trustedPlugins).toBeNull();
    expect(result.roles.size).toBe(0);
    expect(result.overlayIds).toEqual([]);
  });

  it('applies overlay merge end-to-end', () => {
    writeValidBackends();
    writeValidCredentials();
    writeYaml(join(secretsDir(), 'credentials.local.yaml'), {
      schemaVersion: '1',
      credentials: [
        { id: 'gh-token', type: 'github-pat', backend: 'env', backendKey: 'MY_GH_PAT' },
        { id: 'new-cred', type: 'api-key', backend: 'vault', backendKey: 'new/key' },
      ],
    });

    const messages: string[] = [];
    const result = loadConfig({
      agencyDir,
      logger: { info: (msg) => messages.push(msg) },
    });

    expect(result.overlayIds).toEqual(['gh-token', 'new-cred']);
    const ghToken = result.credentials.credentials.find((c) => c.id === 'gh-token')!;
    expect(ghToken.type).toBe('github-pat');
    expect(ghToken.backend).toBe('env');
    expect(result.credentials.credentials.find((c) => c.id === 'new-cred')).toBeDefined();
    expect(messages[0]).toContain('gh-token');
  });

  it('resolves role extends end-to-end', () => {
    writeValidBackends();
    writeValidCredentials();
    writeValidRole('reviewer', {
      schemaVersion: '1',
      id: 'reviewer',
      description: 'Reviewer',
      credentials: [{ ref: 'gcp-sa', expose: [{ as: 'gcloud-external-account' }] }],
    });
    writeValidRole('developer', {
      schemaVersion: '1',
      id: 'developer',
      description: 'Developer',
      extends: 'reviewer',
      credentials: [{ ref: 'gh-token', expose: [{ as: 'env', name: 'GH' }] }],
    });

    const result = loadConfig({ agencyDir });

    const dev = result.roles.get('developer')!;
    expect(dev.credentials).toHaveLength(2);
    expect(dev.credentials.map((c) => c.ref).sort()).toEqual(['gcp-sa', 'gh-token']);
    expect(dev.extends).toBeUndefined();
  });

  it('reports multiple validation errors together', () => {
    writeValidBackends();
    writeYaml(join(secretsDir(), 'credentials.yaml'), {
      schemaVersion: '1',
      credentials: [
        { id: 'bad-cred', type: 'x', backend: 'nonexistent', backendKey: 'k' },
      ],
    });
    writeValidRole('role', {
      schemaVersion: '1',
      id: 'role',
      description: 'Role',
      credentials: [{ ref: 'missing-ref', expose: [{ as: 'env' }] }],
    });

    try {
      loadConfig({ agencyDir });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors.length).toBeGreaterThanOrEqual(2);
      expect(e.errors.some((x) => x.message.includes('Backend'))).toBe(true);
      expect(e.errors.some((x) => x.message.includes('Credential'))).toBe(true);
    }
  });

  it('handles empty roles directory as valid', () => {
    writeValidBackends();
    writeValidCredentials();
    // roles dir exists but has no files

    const result = loadConfig({ agencyDir });

    expect(result.roles.size).toBe(0);
  });

  it('handles missing roles directory as valid', () => {
    writeValidBackends();
    writeValidCredentials();
    rmSync(rolesDir(), { recursive: true, force: true });

    const result = loadConfig({ agencyDir });

    expect(result.roles.size).toBe(0);
  });
});
