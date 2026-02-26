import { describe, it, expect, beforeEach } from 'vitest';
import { CheckRegistry } from '../registry.js';
import type { CheckDefinition, CheckContext, CheckResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal check definition for testing. */
function makeCheck(
  overrides: Partial<CheckDefinition> & Pick<CheckDefinition, 'id'>,
): CheckDefinition {
  return {
    label: overrides.id,
    category: 'system',
    dependencies: [],
    priority: 'P1',
    run: async () => ({ status: 'pass', message: 'ok' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CheckRegistry', () => {
  let registry: CheckRegistry;

  beforeEach(() => {
    registry = new CheckRegistry();
  });

  // -----------------------------------------------------------------------
  // Registration & retrieval
  // -----------------------------------------------------------------------

  describe('register / getChecks', () => {
    it('registers a check and retrieves it', () => {
      const check = makeCheck({ id: 'docker' });
      registry.register(check);

      const checks = registry.getChecks();
      expect(checks).toHaveLength(1);
      expect(checks[0].id).toBe('docker');
    });

    it('preserves insertion order', () => {
      registry.register(makeCheck({ id: 'alpha' }));
      registry.register(makeCheck({ id: 'beta' }));
      registry.register(makeCheck({ id: 'gamma' }));

      const ids = registry.getChecks().map((c) => c.id);
      expect(ids).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('throws on duplicate check ID', () => {
      registry.register(makeCheck({ id: 'docker' }));
      expect(() => registry.register(makeCheck({ id: 'docker' }))).toThrow(
        "Duplicate check ID: 'docker'",
      );
    });

    it('retrieves a check by ID with getCheck()', () => {
      const check = makeCheck({ id: 'config' });
      registry.register(check);

      expect(registry.getCheck('config')).toBe(check);
      expect(registry.getCheck('nonexistent')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Empty registry
  // -----------------------------------------------------------------------

  describe('empty registry', () => {
    it('getChecks returns empty array', () => {
      expect(registry.getChecks()).toEqual([]);
    });

    it('resolve returns empty array', () => {
      expect(registry.resolve()).toEqual([]);
    });

    it('resolve with empty --check array returns empty array', () => {
      expect(registry.resolve({ check: [] })).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Topological sort
  // -----------------------------------------------------------------------

  describe('topological sort', () => {
    it('returns checks with no dependencies in alphabetical order', () => {
      registry.register(makeCheck({ id: 'docker' }));
      registry.register(makeCheck({ id: 'config' }));
      registry.register(makeCheck({ id: 'npm-packages' }));

      const ids = registry.resolve().map((c) => c.id);
      expect(ids).toEqual(['config', 'docker', 'npm-packages']);
    });

    it('orders dependencies before dependents (simple chain)', () => {
      // env-file depends on config
      registry.register(makeCheck({ id: 'env-file', dependencies: ['config'] }));
      registry.register(makeCheck({ id: 'config' }));

      const ids = registry.resolve().map((c) => c.id);
      expect(ids).toEqual(['config', 'env-file']);
    });

    it('orders a multi-level dependency chain correctly', () => {
      // github-token → env-file → config
      registry.register(
        makeCheck({ id: 'github-token', dependencies: ['env-file'] }),
      );
      registry.register(
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
      );
      registry.register(makeCheck({ id: 'config' }));

      const ids = registry.resolve().map((c) => c.id);
      expect(ids.indexOf('config')).toBeLessThan(ids.indexOf('env-file'));
      expect(ids.indexOf('env-file')).toBeLessThan(ids.indexOf('github-token'));
    });

    it('handles diamond dependencies', () => {
      // Both github-token and anthropic-key depend on env-file, which depends on config
      registry.register(makeCheck({ id: 'config' }));
      registry.register(
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
      );
      registry.register(
        makeCheck({ id: 'github-token', dependencies: ['env-file'] }),
      );
      registry.register(
        makeCheck({ id: 'anthropic-key', dependencies: ['env-file'] }),
      );

      const ids = registry.resolve().map((c) => c.id);

      // config must come before env-file
      expect(ids.indexOf('config')).toBeLessThan(ids.indexOf('env-file'));
      // env-file must come before both credential checks
      expect(ids.indexOf('env-file')).toBeLessThan(
        ids.indexOf('github-token'),
      );
      expect(ids.indexOf('env-file')).toBeLessThan(
        ids.indexOf('anthropic-key'),
      );
    });

    it('runs independent checks concurrently-ready (same tier)', () => {
      registry.register(makeCheck({ id: 'docker' }));
      registry.register(makeCheck({ id: 'devcontainer' }));
      registry.register(makeCheck({ id: 'npm-packages' }));

      const ids = registry.resolve().map((c) => c.id);
      // All three have no deps so they should all be in the result
      expect(ids).toHaveLength(3);
      // Sorted alphabetically within the same tier
      expect(ids).toEqual(['devcontainer', 'docker', 'npm-packages']);
    });
  });

  // -----------------------------------------------------------------------
  // Circular dependency detection
  // -----------------------------------------------------------------------

  describe('circular dependency detection', () => {
    it('throws on direct circular dependency (A ↔ B)', () => {
      registry.register(makeCheck({ id: 'a', dependencies: ['b'] }));
      registry.register(makeCheck({ id: 'b', dependencies: ['a'] }));

      expect(() => registry.resolve()).toThrow(/[Cc]ircular dependency/);
    });

    it('throws on indirect circular dependency (A → B → C → A)', () => {
      registry.register(makeCheck({ id: 'a', dependencies: ['c'] }));
      registry.register(makeCheck({ id: 'b', dependencies: ['a'] }));
      registry.register(makeCheck({ id: 'c', dependencies: ['b'] }));

      expect(() => registry.resolve()).toThrow(/[Cc]ircular dependency/);
    });

    it('includes the cycle participants in the error message', () => {
      registry.register(makeCheck({ id: 'x', dependencies: ['y'] }));
      registry.register(makeCheck({ id: 'y', dependencies: ['x'] }));

      expect(() => registry.resolve()).toThrow(/x/);
      expect(() => registry.resolve()).toThrow(/y/);
    });

    it('self-referencing check is detected as circular', () => {
      registry.register(makeCheck({ id: 'self', dependencies: ['self'] }));

      expect(() => registry.resolve()).toThrow(/[Cc]ircular dependency/);
    });
  });

  // -----------------------------------------------------------------------
  // --check with auto-included dependencies
  // -----------------------------------------------------------------------

  describe('--check with auto-included dependencies', () => {
    beforeEach(() => {
      registry.register(makeCheck({ id: 'config' }));
      registry.register(
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
      );
      registry.register(
        makeCheck({ id: 'github-token', dependencies: ['env-file'] }),
      );
      registry.register(
        makeCheck({ id: 'anthropic-key', dependencies: ['env-file'] }),
      );
      registry.register(makeCheck({ id: 'docker' }));
    });

    it('includes only the specified check when it has no deps', () => {
      const ids = registry.resolve({ check: ['docker'] }).map((c) => c.id);
      expect(ids).toEqual(['docker']);
    });

    it('auto-includes direct dependencies', () => {
      const ids = registry.resolve({ check: ['env-file'] }).map((c) => c.id);
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');
      expect(ids).not.toContain('docker');
      expect(ids).not.toContain('github-token');
    });

    it('auto-includes transitive dependencies', () => {
      const ids = registry
        .resolve({ check: ['github-token'] })
        .map((c) => c.id);
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');
      expect(ids).toContain('github-token');
      expect(ids).not.toContain('docker');
      expect(ids).not.toContain('anthropic-key');
    });

    it('merges dependencies from multiple --check targets', () => {
      const ids = registry
        .resolve({ check: ['github-token', 'docker'] })
        .map((c) => c.id);
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');
      expect(ids).toContain('github-token');
      expect(ids).toContain('docker');
      expect(ids).not.toContain('anthropic-key');
    });

    it('deduplicates shared dependencies', () => {
      const ids = registry
        .resolve({ check: ['github-token', 'anthropic-key'] })
        .map((c) => c.id);

      // config and env-file should each appear exactly once
      expect(ids.filter((id) => id === 'config')).toHaveLength(1);
      expect(ids.filter((id) => id === 'env-file')).toHaveLength(1);
    });

    it('preserves dependency order in result', () => {
      const ids = registry
        .resolve({ check: ['github-token'] })
        .map((c) => c.id);
      expect(ids.indexOf('config')).toBeLessThan(ids.indexOf('env-file'));
      expect(ids.indexOf('env-file')).toBeLessThan(
        ids.indexOf('github-token'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // --skip exclusion
  // -----------------------------------------------------------------------

  describe('--skip exclusion', () => {
    beforeEach(() => {
      registry.register(makeCheck({ id: 'docker' }));
      registry.register(makeCheck({ id: 'config' }));
      registry.register(
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
      );
      registry.register(makeCheck({ id: 'npm-packages' }));
    });

    it('excludes a skipped check from the result', () => {
      const ids = registry.resolve({ skip: ['docker'] }).map((c) => c.id);
      expect(ids).not.toContain('docker');
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');
      expect(ids).toContain('npm-packages');
    });

    it('excludes multiple skipped checks', () => {
      const ids = registry
        .resolve({ skip: ['docker', 'npm-packages'] })
        .map((c) => c.id);
      expect(ids).not.toContain('docker');
      expect(ids).not.toContain('npm-packages');
      expect(ids).toContain('config');
      expect(ids).toContain('env-file');
    });

    it('skipping a dependency still includes the dependent (runner handles skip propagation)', () => {
      // The registry doesn't prevent this — the runner handles skip propagation at runtime
      const ids = registry.resolve({ skip: ['config'] }).map((c) => c.id);
      expect(ids).not.toContain('config');
      // env-file is still in the list — the runner will skip it at runtime
      expect(ids).toContain('env-file');
    });
  });

  // -----------------------------------------------------------------------
  // Unknown check name rejection
  // -----------------------------------------------------------------------

  describe('unknown check name rejection', () => {
    beforeEach(() => {
      registry.register(makeCheck({ id: 'docker' }));
      registry.register(makeCheck({ id: 'config' }));
    });

    it('throws on unknown name in --check', () => {
      expect(() => registry.resolve({ check: ['nonexistent'] })).toThrow(
        /[Uu]nknown check.*'nonexistent'/,
      );
    });

    it('throws on unknown name in --skip', () => {
      expect(() => registry.resolve({ skip: ['bogus'] })).toThrow(
        /[Uu]nknown check.*'bogus'/,
      );
    });

    it('includes available check names in error message', () => {
      expect(() => registry.resolve({ check: ['fake'] })).toThrow(/docker/);
      expect(() => registry.resolve({ check: ['fake'] })).toThrow(/config/);
    });

    it('reports multiple unknown names', () => {
      expect(() =>
        registry.resolve({ check: ['fake1', 'fake2'] }),
      ).toThrow(/fake1/);
      expect(() =>
        registry.resolve({ check: ['fake1', 'fake2'] }),
      ).toThrow(/fake2/);
    });

    it('identifies the flag in error message (--check vs --skip)', () => {
      expect(() => registry.resolve({ check: ['bad'] })).toThrow(/--check/);
      expect(() => registry.resolve({ skip: ['bad'] })).toThrow(/--skip/);
    });
  });

  // -----------------------------------------------------------------------
  // Combined --check and --skip
  // -----------------------------------------------------------------------

  describe('combined --check and --skip', () => {
    beforeEach(() => {
      registry.register(makeCheck({ id: 'config' }));
      registry.register(
        makeCheck({ id: 'env-file', dependencies: ['config'] }),
      );
      registry.register(
        makeCheck({ id: 'github-token', dependencies: ['env-file'] }),
      );
      registry.register(makeCheck({ id: 'docker' }));
    });

    it('--check selects and --skip further filters', () => {
      // Request github-token (which pulls in config + env-file), then skip env-file
      const ids = registry
        .resolve({ check: ['github-token'], skip: ['env-file'] })
        .map((c) => c.id);

      expect(ids).toContain('config');
      expect(ids).toContain('github-token');
      expect(ids).not.toContain('env-file');
      expect(ids).not.toContain('docker');
    });
  });

  // -----------------------------------------------------------------------
  // Full realistic scenario
  // -----------------------------------------------------------------------

  describe('realistic check set', () => {
    beforeEach(() => {
      // Register the full set of checks matching the doctor command
      registry.register(
        makeCheck({ id: 'docker', category: 'system', dependencies: [] }),
      );
      registry.register(
        makeCheck({ id: 'config', category: 'config', dependencies: [] }),
      );
      registry.register(
        makeCheck({
          id: 'devcontainer',
          category: 'system',
          dependencies: [],
          priority: 'P2',
        }),
      );
      registry.register(
        makeCheck({
          id: 'npm-packages',
          category: 'packages',
          dependencies: [],
          priority: 'P2',
        }),
      );
      registry.register(
        makeCheck({
          id: 'agency-mcp',
          category: 'services',
          dependencies: [],
          priority: 'P2',
        }),
      );
      registry.register(
        makeCheck({
          id: 'env-file',
          category: 'config',
          dependencies: ['config'],
        }),
      );
      registry.register(
        makeCheck({
          id: 'github-token',
          category: 'credentials',
          dependencies: ['env-file'],
        }),
      );
      registry.register(
        makeCheck({
          id: 'anthropic-key',
          category: 'credentials',
          dependencies: ['env-file'],
        }),
      );
    });

    it('resolves all 8 checks', () => {
      const checks = registry.resolve();
      expect(checks).toHaveLength(8);
    });

    it('places tier-0 checks before tier-1 before tier-2', () => {
      const ids = registry.resolve().map((c) => c.id);

      // Tier 0: no deps — agency-mcp, config, devcontainer, docker, npm-packages
      // Tier 1: env-file (depends on config)
      // Tier 2: anthropic-key, github-token (depend on env-file)

      // config must precede env-file
      expect(ids.indexOf('config')).toBeLessThan(ids.indexOf('env-file'));
      // env-file must precede both credential checks
      expect(ids.indexOf('env-file')).toBeLessThan(
        ids.indexOf('github-token'),
      );
      expect(ids.indexOf('env-file')).toBeLessThan(
        ids.indexOf('anthropic-key'),
      );
    });

    it('--check github-token includes config and env-file but not docker', () => {
      const ids = registry
        .resolve({ check: ['github-token'] })
        .map((c) => c.id);
      expect(ids).toEqual(['config', 'env-file', 'github-token']);
    });

    it('--skip docker removes docker from the full set', () => {
      const ids = registry.resolve({ skip: ['docker'] }).map((c) => c.id);
      expect(ids).not.toContain('docker');
      expect(ids).toHaveLength(7);
    });
  });
});
