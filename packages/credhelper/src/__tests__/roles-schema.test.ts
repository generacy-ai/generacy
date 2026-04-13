import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoleConfigSchema } from '../schemas/roles.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): unknown {
  return parse(readFileSync(resolve(fixturesDir, name), 'utf-8'));
}

describe('RoleConfigSchema', () => {
  it('parses the reviewer role fixture', () => {
    const data = loadFixture('roles/reviewer.yaml');
    const result = RoleConfigSchema.parse(data);

    expect(result.schemaVersion).toBe('1');
    expect(result.id).toBe('reviewer');
    expect(result.description).toContain('Read-only');
    expect(result.extends).toBeUndefined();
    expect(result.credentials).toHaveLength(2);

    const github = result.credentials[0]!;
    expect(github.ref).toBe('github-main-org');
    expect(github.scope).toBeDefined();
    expect(github.expose).toHaveLength(2);
    expect(github.expose[0]!.as).toBe('git-credential-helper');
    expect(github.expose[1]!.as).toBe('env');
    expect(github.expose[1]!.name).toBe('GITHUB_TOKEN');
  });

  it('parses the developer role with extends', () => {
    const data = loadFixture('roles/developer.yaml');
    const result = RoleConfigSchema.parse(data);

    expect(result.id).toBe('developer');
    expect(result.extends).toBe('reviewer');
    expect(result.credentials).toHaveLength(1);
  });

  it('parses the devops role with proxy config', () => {
    const data = loadFixture('roles/devops.yaml');
    const result = RoleConfigSchema.parse(data);

    expect(result.id).toBe('devops');
    expect(result.credentials).toHaveLength(2);

    const sendgridCred = result.credentials[1]!;
    expect(sendgridCred.expose[0]!.as).toBe('localhost-proxy');
    expect(sendgridCred.expose[0]!.port).toBe(7823);

    expect(result.proxy).toBeDefined();
    const sendgridProxy = result.proxy!['sendgrid']!;
    expect(sendgridProxy.upstream).toBe('https://api.sendgrid.com');
    expect(sendgridProxy.default).toBe('deny');
    expect(sendgridProxy.allow).toHaveLength(1);
    expect(sendgridProxy.allow[0]!.method).toBe('POST');
    expect(sendgridProxy.allow[0]!.path).toBe('/v3/mail/send');
  });

  it('validates all exposure kinds', () => {
    const validKinds = ['env', 'git-credential-helper', 'gcloud-external-account', 'localhost-proxy', 'docker-socket-proxy'];
    for (const kind of validKinds) {
      const data = {
        schemaVersion: '1',
        id: 'test',
        description: 'test',
        credentials: [{
          ref: 'test-cred',
          expose: [{ as: kind }],
        }],
      };
      expect(() => RoleConfigSchema.parse(data)).not.toThrow();
    }
  });

  it('rejects invalid exposure kind', () => {
    const data = {
      schemaVersion: '1',
      id: 'test',
      description: 'test',
      credentials: [{
        ref: 'test-cred',
        expose: [{ as: 'invalid-kind' }],
      }],
    };
    expect(() => RoleConfigSchema.parse(data)).toThrow();
  });

  it('rejects role missing id', () => {
    const data = {
      schemaVersion: '1',
      description: 'test',
      credentials: [],
    };
    expect(() => RoleConfigSchema.parse(data)).toThrow();
  });

  it('rejects role missing description', () => {
    const data = {
      schemaVersion: '1',
      id: 'test',
      credentials: [],
    };
    expect(() => RoleConfigSchema.parse(data)).toThrow();
  });

  it('parses docker config', () => {
    const data = {
      schemaVersion: '1',
      id: 'fullstack',
      description: 'test',
      credentials: [],
      docker: {
        default: 'deny',
        allow: [
          { method: 'GET', path: '/containers/json' },
          { method: 'POST', path: '/containers/{id}/start', name: 'firebase-*' },
        ],
      },
    };
    const result = RoleConfigSchema.parse(data);
    expect(result.docker).toBeDefined();
    expect(result.docker!.default).toBe('deny');
    expect(result.docker!.allow).toHaveLength(2);
    expect(result.docker!.allow[1]!.name).toBe('firebase-*');
  });
});
