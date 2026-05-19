import { describe, it, expect } from 'vitest';
import type { BackendsConfig } from '../schemas/backends.js';
import type { CredentialEntry } from '../schemas/credentials.js';
import type { RoleConfig } from '../schemas/roles.js';
import type { ExposureKind } from '../types/exposure.js';
import type { ConfigError } from '../config/types.js';
import {
  validateCredentialBackendRefs,
  validateRoleCredentialRefs,
  validateExposurePluginSupport,
} from '../config/validator.js';

function makeBackends(...ids: string[]): BackendsConfig {
  return {
    schemaVersion: '1',
    backends: ids.map((id) => ({ id, type: id })),
  };
}

function makeCred(id: string, backend: string, type = 'token'): CredentialEntry {
  return { id, type, backend, backendKey: `key-${id}` };
}

function makeRole(id: string, refs: { ref: string; expose: { as: ExposureKind }[] }[]): RoleConfig {
  return {
    schemaVersion: '1',
    id,
    description: `Role ${id}`,
    credentials: refs.map((r) => ({ ref: r.ref, expose: r.expose })),
  };
}

describe('validateCredentialBackendRefs', () => {
  it('produces no errors when all backends exist', () => {
    const errors: ConfigError[] = [];
    validateCredentialBackendRefs(
      [makeCred('c1', 'vault'), makeCred('c2', 'env')],
      makeBackends('vault', 'env'),
      'credentials.yaml',
      errors,
    );
    expect(errors).toHaveLength(0);
  });

  it('reports a missing backend reference', () => {
    const errors: ConfigError[] = [];
    validateCredentialBackendRefs(
      [makeCred('c1', 'missing-backend')],
      makeBackends('vault'),
      'credentials.yaml',
      errors,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe('credentials.yaml');
    expect(errors[0]!.field).toBe('credentials[id=c1].backend');
    expect(errors[0]!.message).toContain('missing-backend');
  });
});

describe('validateRoleCredentialRefs', () => {
  it('produces no errors when all credential refs exist', () => {
    const errors: ConfigError[] = [];
    const roles = new Map([
      ['dev', makeRole('dev', [{ ref: 'c1', expose: [{ as: 'env' }] }])],
    ]);
    validateRoleCredentialRefs(roles, new Set(['c1']), errors);
    expect(errors).toHaveLength(0);
  });

  it('reports a missing credential ref', () => {
    const errors: ConfigError[] = [];
    const roles = new Map([
      ['dev', makeRole('dev', [{ ref: 'no-such-cred', expose: [{ as: 'env' }] }])],
    ]);
    validateRoleCredentialRefs(roles, new Set(['c1']), errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe('roles/dev.yaml');
    expect(errors[0]!.field).toBe('credentials[ref=no-such-cred]');
    expect(errors[0]!.message).toContain('no-such-cred');
  });
});

describe('validateExposurePluginSupport', () => {
  it('produces no errors when all exposure kinds are supported', () => {
    const errors: ConfigError[] = [];
    const roles = new Map([
      ['dev', makeRole('dev', [{ ref: 'c1', expose: [{ as: 'env' }] }])],
    ]);
    const creds = [makeCred('c1', 'vault', 'token')];
    const registry = new Map<string, ExposureKind[]>([['token', ['env', 'localhost-proxy']]]);
    validateExposurePluginSupport(roles, creds, registry, errors);
    expect(errors).toHaveLength(0);
  });

  it('reports an unsupported exposure kind', () => {
    const errors: ConfigError[] = [];
    const roles = new Map([
      ['dev', makeRole('dev', [{ ref: 'c1', expose: [{ as: 'docker-socket-proxy' }] }])],
    ]);
    const creds = [makeCred('c1', 'vault', 'token')];
    const registry = new Map<string, ExposureKind[]>([['token', ['env']]]);
    validateExposurePluginSupport(roles, creds, registry, errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe('roles/dev.yaml');
    expect(errors[0]!.field).toBe('credentials[ref=c1].expose[as=docker-socket-proxy]');
    expect(errors[0]!.message).toContain('docker-socket-proxy');
    expect(errors[0]!.message).toContain('token');
  });

  it('skips validation when credential type is not in the registry', () => {
    const errors: ConfigError[] = [];
    const roles = new Map([
      ['dev', makeRole('dev', [{ ref: 'c1', expose: [{ as: 'docker-socket-proxy' }] }])],
    ]);
    const creds = [makeCred('c1', 'vault', 'unknown-type')];
    const registry = new Map<string, ExposureKind[]>([['token', ['env']]]);
    validateExposurePluginSupport(roles, creds, registry, errors);
    expect(errors).toHaveLength(0);
  });
});

describe('multiple errors accumulated', () => {
  it('collects errors from all three validators in a single array', () => {
    const errors: ConfigError[] = [];
    const backends = makeBackends('vault');
    const creds = [makeCred('c1', 'vault', 'token'), makeCred('c2', 'gone-backend', 'token')];
    const credIds = new Set(creds.map((c) => c.id));

    const roles = new Map([
      ['dev', makeRole('dev', [
        { ref: 'c1', expose: [{ as: 'docker-socket-proxy' }] },
        { ref: 'phantom', expose: [{ as: 'env' }] },
      ])],
    ]);

    const registry = new Map<string, ExposureKind[]>([['token', ['env']]]);

    validateCredentialBackendRefs(creds, backends, 'credentials.yaml', errors);
    validateRoleCredentialRefs(roles, credIds, errors);
    validateExposurePluginSupport(roles, creds, registry, errors);

    // 1 missing backend (c2 -> gone-backend)
    // 1 missing credential ref (phantom)
    // 1 unsupported exposure (c1 docker-socket-proxy)
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.file)).toEqual(
      expect.arrayContaining(['credentials.yaml', 'roles/dev.yaml']),
    );
  });
});
