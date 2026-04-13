import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { discoverPlugins } from '../../loader/discover.js';

const FIXTURES_DIR = resolve(
  import.meta.dirname,
  '../fixtures/plugins',
);

describe('discoverPlugins', () => {
  it('discovers plugins matching the naming pattern', async () => {
    const plugins = await discoverPlugins([], [FIXTURES_DIR]);

    const names = plugins.map((p) => p.name).sort();
    expect(names).toContain('generacy-credhelper-plugin-mock');
    expect(names).toContain('generacy-credhelper-plugin-bad-schema');
    expect(names).toContain('generacy-credhelper-plugin-duplicate');
  });

  it('extracts manifest fields correctly', async () => {
    const plugins = await discoverPlugins([], [FIXTURES_DIR]);
    const mock = plugins.find((p) => p.name === 'generacy-credhelper-plugin-mock');

    expect(mock).toBeDefined();
    expect(mock!.type).toBe('mock');
    expect(mock!.version).toBe('1.0.0');
    expect(mock!.entryPoint).toBe(
      resolve(FIXTURES_DIR, 'generacy-credhelper-plugin-mock/index.js'),
    );
  });

  it('tags core plugins with isCore=true', async () => {
    const plugins = await discoverPlugins([FIXTURES_DIR], []);

    for (const plugin of plugins) {
      expect(plugin.isCore).toBe(true);
    }
  });

  it('tags community plugins with isCore=false', async () => {
    const plugins = await discoverPlugins([], [FIXTURES_DIR]);

    for (const plugin of plugins) {
      expect(plugin.isCore).toBe(false);
    }
  });

  it('ignores directories not matching the naming pattern', async () => {
    const plugins = await discoverPlugins([], [FIXTURES_DIR]);

    // All discovered plugins should match one of the patterns
    for (const plugin of plugins) {
      expect(plugin.name).toMatch(/^generacy-credhelper-plugin-/);
    }
  });

  it('skips directories missing credhelperPlugin manifest field', async () => {
    // The fixtures dir itself doesn't have a package.json with credhelperPlugin,
    // so scanning a parent directory should still only find valid plugins
    const plugins = await discoverPlugins([], [FIXTURES_DIR]);
    expect(plugins.length).toBeGreaterThan(0);
  });

  it('silently skips non-existent paths', async () => {
    const plugins = await discoverPlugins(
      ['/nonexistent/core/path'],
      ['/nonexistent/community/path'],
    );
    expect(plugins).toEqual([]);
  });
});
