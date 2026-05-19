import { describe, it, expect } from 'vitest';
import { resolveRoleExtends } from '../config/role-resolver.js';
import type { RoleConfig, RoleCredentialRef } from '../schemas/roles.js';
import type { ConfigError } from '../config/types.js';

function makeRole(
  id: string,
  opts: { extends?: string; credentials?: RoleCredentialRef[] } = {},
): RoleConfig {
  return {
    schemaVersion: '1',
    id,
    description: `${id} role`,
    ...(opts.extends ? { extends: opts.extends } : {}),
    credentials: opts.credentials ?? [],
  };
}

function cred(ref: string): RoleCredentialRef {
  return { ref, expose: [{ as: 'env' }] };
}

describe('resolveRoleExtends', () => {
  it('passes through a role without extends unchanged', () => {
    const roles = new Map([['base', makeRole('base', { credentials: [cred('a')] })]]);
    const errors: ConfigError[] = [];

    const resolved = resolveRoleExtends(roles, errors);

    expect(errors).toHaveLength(0);
    expect(resolved.get('base')).toEqual(roles.get('base'));
  });

  it('inherits parent credentials via single-level extends', () => {
    const parent = makeRole('parent', { credentials: [cred('a'), cred('b')] });
    const child = makeRole('child', { extends: 'parent', credentials: [cred('c')] });
    const roles = new Map([
      ['parent', parent],
      ['child', child],
    ]);
    const errors: ConfigError[] = [];

    const resolved = resolveRoleExtends(roles, errors);

    expect(errors).toHaveLength(0);
    const resolvedChild = resolved.get('child')!;
    expect(resolvedChild.extends).toBeUndefined();
    expect(resolvedChild.credentials).toHaveLength(3);
    expect(resolvedChild.credentials.map((c) => c.ref)).toEqual(['a', 'b', 'c']);
  });

  it('resolves multi-level extends chain (grandparent -> parent -> child)', () => {
    const gp = makeRole('grandparent', { credentials: [cred('a')] });
    const p = makeRole('parent', { extends: 'grandparent', credentials: [cred('b')] });
    const c = makeRole('child', { extends: 'parent', credentials: [cred('c')] });
    const roles = new Map([
      ['grandparent', gp],
      ['parent', p],
      ['child', c],
    ]);
    const errors: ConfigError[] = [];

    const resolved = resolveRoleExtends(roles, errors);

    expect(errors).toHaveLength(0);
    const resolvedChild = resolved.get('child')!;
    expect(resolvedChild.credentials.map((c) => c.ref)).toEqual(['a', 'b', 'c']);

    const resolvedParent = resolved.get('parent')!;
    expect(resolvedParent.credentials.map((c) => c.ref)).toEqual(['a', 'b']);
  });

  it('child credential overrides parent entry with the same ref', () => {
    const parentCred: RoleCredentialRef = { ref: 'shared', expose: [{ as: 'env', name: 'PARENT' }] };
    const childCred: RoleCredentialRef = { ref: 'shared', expose: [{ as: 'env', name: 'CHILD' }] };

    const parent = makeRole('parent', { credentials: [parentCred, cred('other')] });
    const child = makeRole('child', { extends: 'parent', credentials: [childCred] });
    const roles = new Map([
      ['parent', parent],
      ['child', child],
    ]);
    const errors: ConfigError[] = [];

    const resolved = resolveRoleExtends(roles, errors);

    expect(errors).toHaveLength(0);
    const resolvedChild = resolved.get('child')!;
    expect(resolvedChild.credentials).toHaveLength(2);
    const sharedCred = resolvedChild.credentials.find((c) => c.ref === 'shared')!;
    expect(sharedCred.expose[0]!.name).toBe('CHILD');
  });

  it('detects circular extends and pushes an error', () => {
    const a = makeRole('a', { extends: 'b' });
    const b = makeRole('b', { extends: 'a' });
    const roles = new Map([
      ['a', a],
      ['b', b],
    ]);
    const errors: ConfigError[] = [];

    resolveRoleExtends(roles, errors);

    const circularError = errors.find((e) => e.message.includes('Circular extends chain detected'));
    expect(circularError).toBeDefined();
  });

  it('pushes an error when parent role is missing but keeps role usable', () => {
    const child = makeRole('child', { extends: 'nonexistent', credentials: [cred('x')] });
    const roles = new Map([['child', child]]);
    const errors: ConfigError[] = [];

    const resolved = resolveRoleExtends(roles, errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('not found');
    expect(errors[0]!.field).toBe('extends');

    const resolvedChild = resolved.get('child')!;
    expect(resolvedChild).toBeDefined();
    expect(resolvedChild.credentials).toEqual([cred('x')]);
    expect(resolvedChild.extends).toBeUndefined();
  });
});
