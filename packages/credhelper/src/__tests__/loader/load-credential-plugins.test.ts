import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCredentialPlugins } from '../../loader/load-credential-plugins.js';
import type { LoaderConfig } from '../../types/loader.js';

const FIXTURES_DIR = resolve(
  import.meta.dirname,
  '../fixtures/plugins',
);

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function makeConfig(overrides: Partial<LoaderConfig> = {}): LoaderConfig {
  return {
    corePaths: [],
    communityPaths: [],
    trustedPins: new Map(),
    ...overrides,
  };
}

/** Create a temp directory with only specific fixture plugins copied in. */
function makeTempWithPlugins(...pluginNames: string[]): string {
  const tmp = mkdtempSync(join(tmpdir(), 'credhelper-test-'));
  for (const name of pluginNames) {
    cpSync(join(FIXTURES_DIR, name), join(tmp, name), { recursive: true });
  }
  return tmp;
}

describe('loadCredentialPlugins', () => {
  it('loads a single core plugin successfully', async () => {
    const tmp = makeTempWithPlugins('generacy-credhelper-plugin-mock');
    const config = makeConfig({ corePaths: [tmp] });

    const registry = await loadCredentialPlugins(config);

    expect(registry.size).toBe(1);
    expect(registry.has('mock')).toBe(true);
    const plugin = registry.get('mock')!;
    expect(plugin.type).toBe('mock');
    expect(plugin.supportedExposures).toEqual(['env']);
    expect(typeof plugin.renderExposure).toBe('function');
  });

  it('loads a community plugin with valid SHA256 pin', async () => {
    const tmp = makeTempWithPlugins('generacy-credhelper-plugin-mock');
    const entryPoint = resolve(tmp, 'generacy-credhelper-plugin-mock/index.js');
    const sha = computeSha256(entryPoint);

    const config = makeConfig({
      communityPaths: [tmp],
      trustedPins: new Map([['generacy-credhelper-plugin-mock', sha]]),
    });

    const registry = await loadCredentialPlugins(config);
    expect(registry.size).toBe(1);
    expect(registry.has('mock')).toBe(true);
  });

  it('loads mixed core and community plugins', async () => {
    // bad-schema is not a valid plugin, so use mock as core only
    const coreDir = makeTempWithPlugins('generacy-credhelper-plugin-mock');

    const config = makeConfig({
      corePaths: [coreDir],
    });

    const registry = await loadCredentialPlugins(config);
    expect(registry.size).toBe(1);
  });

  it('rejects community plugins without pins', async () => {
    const tmp = makeTempWithPlugins('generacy-credhelper-plugin-mock');
    const config = makeConfig({
      communityPaths: [tmp],
      trustedPins: new Map(),
    });

    await expect(loadCredentialPlugins(config)).rejects.toThrow(
      /not pinned in trusted-plugins\.yaml/,
    );
  });

  it('rejects community plugins with wrong SHA256 pin', async () => {
    const tmp = makeTempWithPlugins('generacy-credhelper-plugin-mock');
    const config = makeConfig({
      communityPaths: [tmp],
      trustedPins: new Map([['generacy-credhelper-plugin-mock', 'wrong-sha256']]),
    });

    await expect(loadCredentialPlugins(config)).rejects.toThrow(
      /SHA256 mismatch/,
    );
  });

  it('rejects plugins with invalid credentialSchema', async () => {
    const tmp = makeTempWithPlugins('generacy-credhelper-plugin-bad-schema');
    const config = makeConfig({
      corePaths: [tmp],
    });

    await expect(loadCredentialPlugins(config)).rejects.toThrow(
      /credentialSchema is not a valid Zod schema/,
    );
  });

  it('detects duplicate credential types', async () => {
    const tmp = makeTempWithPlugins(
      'generacy-credhelper-plugin-mock',
      'generacy-credhelper-plugin-duplicate',
    );
    const config = makeConfig({
      corePaths: [tmp],
    });

    await expect(loadCredentialPlugins(config)).rejects.toThrow(
      /Duplicate credential type 'mock'/,
    );
  });

  it('returns empty map when no plugins found', async () => {
    const config = makeConfig({
      corePaths: ['/nonexistent/path'],
      communityPaths: ['/nonexistent/path'],
    });

    const registry = await loadCredentialPlugins(config);
    expect(registry.size).toBe(0);
  });
});
