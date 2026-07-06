import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCockpitConfig } from '../config/loader.js';

async function writeConfig(workspaceDir: string, yaml: string): Promise<void> {
  const dotGeneracy = join(workspaceDir, '.generacy');
  await mkdir(dotGeneracy, { recursive: true });
  await writeFile(join(dotGeneracy, 'config.yaml'), yaml, 'utf-8');
}

describe('loadCockpitConfig', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cockpit-config-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reads cockpit.owner and returns source cockpit-block', async () => {
    await writeConfig(cwd, 'cockpit:\n  owner: alice\n');
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => null,
    });
    expect(result.source).toBe('cockpit-block');
    expect(result.config.owner).toBe('alice');
    expect(result.warnings).toEqual([]);
  });

  it('falls back to whoami() when no owner is set', async () => {
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => 'bob',
    });
    expect(result.source).toBe('defaults');
    expect(result.config.owner).toBe('bob');
  });

  it('leaves owner undefined when both config and whoami fail', async () => {
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => null,
    });
    expect(result.source).toBe('defaults');
    expect(result.config.owner).toBeUndefined();
  });

  it('explicit owner short-circuits whoami', async () => {
    await writeConfig(cwd, 'cockpit:\n  owner: alice\n');
    let called = false;
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => {
        called = true;
        return 'bob';
      },
    });
    expect(result.config.owner).toBe('alice');
    expect(called).toBe(false);
  });

  it('does not read MONITORED_REPOS (v1-simplification G-S2 removal)', async () => {
    const result = await loadCockpitConfig({
      cwd,
      env: { MONITORED_REPOS: 'ignored/repo' },
      whoami: async () => null,
    });
    expect(result.source).toBe('defaults');
    expect((result.config as unknown as { repos?: unknown }).repos).toBeUndefined();
  });
});
