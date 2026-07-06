import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCockpitConfig } from '../config/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'config-samples');

async function setupFixture(workspaceDir: string, fixtureName: string): Promise<void> {
  const dotGeneracy = join(workspaceDir, '.generacy');
  await mkdir(dotGeneracy, { recursive: true });
  await copyFile(join(FIXTURE_DIR, fixtureName), join(dotGeneracy, 'config.yaml'));
}

describe('loadCockpitConfig', () => {
  let cwd: string;
  const env: Record<string, string> = {};

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cockpit-config-'));
    for (const key of Object.keys(env)) delete env[key];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('(a) full config — honors every cockpit field, source = cockpit-block', async () => {
    await setupFixture(cwd, 'full.yaml');
    const result = await loadCockpitConfig({
      cwd,
      env,
      whoami: async () => null,
    });
    expect(result.source).toBe('cockpit-block');
    expect(result.config.owner).toBe('alice');
    expect(result.config.repos).toEqual([
      'generacy-ai/generacy',
      'generacy-ai/generacy-extension',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('(b) partial config — only owner; repos from MONITORED_REPOS env', async () => {
    await setupFixture(cwd, 'partial-owner-only.yaml');
    env['MONITORED_REPOS'] = 'generacy-ai/foo, generacy-ai/bar';
    const result = await loadCockpitConfig({
      cwd,
      env,
      whoami: async () => null,
    });
    expect(result.source).toBe('monitored-repos-env');
    expect(result.config.owner).toBe('alice');
    expect(result.config.repos).toEqual(['generacy-ai/foo', 'generacy-ai/bar']);
    expect(result.warnings).toEqual([]);
  });

  it('(c) missing config — no .generacy/config.yaml, no MONITORED_REPOS → warns + repos: []', async () => {
    const warnings: string[] = [];
    const result = await loadCockpitConfig({
      cwd,
      env,
      whoami: async () => null,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(result.source).toBe('defaults');
    expect(result.config.repos).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(warnings.length).toBe(1);
  });

  it('(d) invalid config — bad owner/repo regex → throws Zod error', async () => {
    await setupFixture(cwd, 'invalid-repos.yaml');
    await expect(
      loadCockpitConfig({ cwd, env, whoami: async () => null }),
    ).rejects.toThrow(/owner\/repo/);
  });

  it('owner falls back to whoami() when not set in config', async () => {
    const result = await loadCockpitConfig({
      cwd,
      env,
      whoami: async () => 'bob',
    });
    expect(result.config.owner).toBe('bob');
  });

  it('explicit owner short-circuits whoami', async () => {
    await setupFixture(cwd, 'partial-owner-only.yaml');
    let whoamiCalled = false;
    const result = await loadCockpitConfig({
      cwd,
      env: { MONITORED_REPOS: 'generacy-ai/foo' },
      whoami: async () => {
        whoamiCalled = true;
        return 'someone-else';
      },
    });
    expect(result.config.owner).toBe('alice');
    expect(whoamiCalled).toBe(false);
  });

  it('MONITORED_REPOS with invalid entry throws', async () => {
    await expect(
      loadCockpitConfig({
        cwd,
        env: { MONITORED_REPOS: 'good/repo,bad' },
        whoami: async () => null,
      }),
    ).rejects.toThrow(/MONITORED_REPOS/);
  });

  it('cockpit.repos non-empty short-circuits MONITORED_REPOS', async () => {
    await setupFixture(cwd, 'full.yaml');
    const result = await loadCockpitConfig({
      cwd,
      env: { MONITORED_REPOS: 'should/be-ignored' },
      whoami: async () => null,
    });
    expect(result.source).toBe('cockpit-block');
    expect(result.config.repos).toEqual([
      'generacy-ai/generacy',
      'generacy-ai/generacy-extension',
    ]);
  });
});
