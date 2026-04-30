import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:os', () => ({
  userInfo: () => ({ username: 'defaultuser' }),
}));

import { parseSshTarget, formatSshTarget } from '../../../src/cli/commands/deploy/ssh-target.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

describe('parseSshTarget', () => {
  it('parses fully-qualified ssh://user@host:2222/path', () => {
    const result = parseSshTarget('ssh://alice@example.com:2222/deploy/app');
    expect(result).toEqual({
      user: 'alice',
      host: 'example.com',
      port: 2222,
      remotePath: '/deploy/app',
    });
  });

  it('defaults user from os.userInfo(), port 22, remotePath null for ssh://host', () => {
    const result = parseSshTarget('ssh://example.com');
    expect(result).toEqual({
      user: 'defaultuser',
      host: 'example.com',
      port: 22,
      remotePath: null,
    });
  });

  it('parses user from URL with default port and no path', () => {
    const result = parseSshTarget('ssh://bob@example.com');
    expect(result).toEqual({
      user: 'bob',
      host: 'example.com',
      port: 22,
      remotePath: null,
    });
  });

  it('parses custom port with default user', () => {
    const result = parseSshTarget('ssh://example.com:8022');
    expect(result).toEqual({
      user: 'defaultuser',
      host: 'example.com',
      port: 8022,
      remotePath: null,
    });
  });

  it('decodes URL-encoded path segments', () => {
    const result = parseSshTarget('ssh://alice@example.com/some%20path');
    expect(result).toEqual({
      user: 'alice',
      host: 'example.com',
      port: 22,
      remotePath: '/some path',
    });
  });

  it('parses IPv6 host in brackets', () => {
    const result = parseSshTarget('ssh://alice@[::1]:22/path');
    // Node's URL.hostname retains brackets for IPv6 addresses
    expect(result).toEqual({
      user: 'alice',
      host: '[::1]',
      port: 22,
      remotePath: '/path',
    });
  });

  it('throws INVALID_TARGET for non-ssh scheme', () => {
    expect(() => parseSshTarget('http://example.com')).toThrow(DeployError);
    try {
      parseSshTarget('http://example.com');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).code).toBe('INVALID_TARGET');
    }
  });

  it('throws INVALID_TARGET for empty string', () => {
    expect(() => parseSshTarget('')).toThrow(DeployError);
    try {
      parseSshTarget('');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).code).toBe('INVALID_TARGET');
    }
  });

  it('throws INVALID_TARGET for missing hostname ssh:///path', () => {
    expect(() => parseSshTarget('ssh:///path')).toThrow(DeployError);
    try {
      parseSshTarget('ssh:///path');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).code).toBe('INVALID_TARGET');
    }
  });
});

describe('formatSshTarget', () => {
  it('round-trips a fully-qualified target', () => {
    const target = parseSshTarget('ssh://alice@example.com:2222/deploy/app');
    const formatted = formatSshTarget(target);
    expect(formatted).toBe('ssh://alice@example.com:2222/deploy/app');
  });

  it('omits port when it is 22', () => {
    const formatted = formatSshTarget({
      user: 'alice',
      host: 'example.com',
      port: 22,
      remotePath: '/data',
    });
    expect(formatted).toBe('ssh://alice@example.com/data');
  });

  it('includes custom port', () => {
    const formatted = formatSshTarget({
      user: 'bob',
      host: 'example.com',
      port: 3022,
      remotePath: null,
    });
    expect(formatted).toBe('ssh://bob@example.com:3022');
  });
});
