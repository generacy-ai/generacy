import { describe, it, expect } from 'vitest';
import {
  sortRoutes,
  resolveRoute,
  isUnixSocket,
  parseUnixTarget,
} from '../src/dispatcher.js';
import type { RouteEntry } from '../src/config.js';

describe('sortRoutes', () => {
  it('sorts routes by prefix length descending', () => {
    const routes: RouteEntry[] = [
      { prefix: '/a', target: 'http://a' },
      { prefix: '/control-plane/admin', target: 'http://admin' },
      { prefix: '/control-plane', target: 'http://cp' },
    ];

    const sorted = sortRoutes(routes);

    expect(sorted.map((r) => r.prefix)).toEqual([
      '/control-plane/admin',
      '/control-plane',
      '/a',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(sortRoutes([])).toEqual([]);
  });

  it('does not mutate the original array', () => {
    const routes: RouteEntry[] = [
      { prefix: '/short', target: 'http://short' },
      { prefix: '/much-longer-prefix', target: 'http://long' },
    ];

    const original = [...routes];
    sortRoutes(routes);

    expect(routes).toEqual(original);
  });
});

describe('resolveRoute', () => {
  it('matches longest prefix when routes are pre-sorted', () => {
    const routes: RouteEntry[] = [
      { prefix: '/control-plane/admin', target: 'http://admin' },
      { prefix: '/control-plane', target: 'http://cp' },
    ];

    const result = resolveRoute('/control-plane/admin/users', routes);

    expect(result).not.toBeNull();
    expect(result!.route.prefix).toBe('/control-plane/admin');
    expect(result!.strippedPath).toBe('/users');
  });

  it('strips prefix and preserves remaining path', () => {
    const routes: RouteEntry[] = [
      { prefix: '/control-plane', target: 'http://cp' },
    ];

    const result = resolveRoute('/control-plane/api/setup', routes);

    expect(result).not.toBeNull();
    expect(result!.strippedPath).toBe('/api/setup');
  });

  it('returns / when path equals prefix exactly', () => {
    const routes: RouteEntry[] = [
      { prefix: '/control-plane', target: 'http://cp' },
    ];

    const result = resolveRoute('/control-plane', routes);

    expect(result).not.toBeNull();
    expect(result!.strippedPath).toBe('/');
  });

  it('returns null when no route matches', () => {
    const routes: RouteEntry[] = [
      { prefix: '/control-plane', target: 'http://cp' },
    ];

    const result = resolveRoute('/other/path', routes);

    expect(result).toBeNull();
  });

  it('returns null for empty routes array', () => {
    const result = resolveRoute('/anything', []);

    expect(result).toBeNull();
  });
});

describe('isUnixSocket', () => {
  it('returns true for unix:// target', () => {
    expect(isUnixSocket('unix:///run/sock')).toBe(true);
  });

  it('returns false for http:// target', () => {
    expect(isUnixSocket('http://localhost:3000')).toBe(false);
  });
});

describe('parseUnixTarget', () => {
  it('extracts socket path from unix:// target', () => {
    expect(
      parseUnixTarget('unix:///run/generacy-control-plane/control.sock'),
    ).toBe('/run/generacy-control-plane/control.sock');
  });
});
