import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyPluginPins } from '../../loader/verify.js';
import type { DiscoveredPlugin } from '../../types/loader.js';

const FIXTURES_DIR = resolve(
  import.meta.dirname,
  '../fixtures/plugins',
);

function makePlugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  const entryPoint = resolve(
    FIXTURES_DIR,
    'generacy-credhelper-plugin-mock/index.js',
  );
  return {
    name: 'generacy-credhelper-plugin-mock',
    path: resolve(FIXTURES_DIR, 'generacy-credhelper-plugin-mock'),
    entryPoint,
    type: 'mock',
    version: '1.0.0',
    isCore: false,
    ...overrides,
  };
}

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

describe('verifyPluginPins', () => {
  it('passes when community plugin SHA256 matches trusted pin', async () => {
    const plugin = makePlugin();
    const sha = computeSha256(plugin.entryPoint);
    const pins = new Map([['generacy-credhelper-plugin-mock', sha]]);

    const result = await verifyPluginPins([plugin], pins);
    expect(result).toEqual([plugin]);
  });

  it('skips verification for core plugins', async () => {
    const plugin = makePlugin({ isCore: true });
    // Empty pins — core plugins don't need them
    const result = await verifyPluginPins([plugin], new Map());
    expect(result).toEqual([plugin]);
  });

  it('throws for unpinned community plugin', async () => {
    const plugin = makePlugin();
    const pins = new Map<string, string>();

    await expect(verifyPluginPins([plugin], pins)).rejects.toThrow(
      /not pinned in trusted-plugins\.yaml/,
    );
  });

  it('throws for SHA256 mismatch', async () => {
    const plugin = makePlugin();
    const pins = new Map([['generacy-credhelper-plugin-mock', 'wrong-sha256-value']]);

    await expect(verifyPluginPins([plugin], pins)).rejects.toThrow(
      /SHA256 mismatch/,
    );
  });

  it('includes plugin name in error messages', async () => {
    const plugin = makePlugin({ name: 'generacy-credhelper-plugin-custom' });
    const pins = new Map<string, string>();

    await expect(verifyPluginPins([plugin], pins)).rejects.toThrow(
      'generacy-credhelper-plugin-custom',
    );
  });
});
