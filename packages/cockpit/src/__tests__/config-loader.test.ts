import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCockpitConfig } from '../config/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

  it('reads cockpit.assignee and round-trips it through the loader', async () => {
    await writeConfig(cwd, 'cockpit:\n  assignee: someone\n');
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => null,
    });
    expect(result.source).toBe('cockpit-block');
    expect(result.config.assignee).toBe('someone');
  });

  it('rejects empty-string cockpit.assignee via Zod parse', async () => {
    await writeConfig(cwd, "cockpit:\n  assignee: ''\n");
    await expect(
      loadCockpitConfig({
        cwd,
        whoami: async () => null,
      }),
    ).rejects.toThrow();
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

  it('strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit: (R4 strip mode)', async () => {
    const fixture = await readFile(
      join(HERE, 'fixtures', 'config-samples', 'legacy-orchestrator-keys.yaml'),
      'utf-8',
    );
    await writeConfig(cwd, fixture);
    const result = await loadCockpitConfig({
      cwd,
      whoami: async () => null,
    });
    expect(result.config.owner).toBe('alice');
    expect(
      (result.config as unknown as { orchestrator?: unknown }).orchestrator,
    ).toBeUndefined();
    expect(
      (result.config as unknown as { stuckThresholdMinutes?: unknown })
        .stuckThresholdMinutes,
    ).toBeUndefined();
  });

  it('parses a full cockpit.auto block (loop, heartbeatSeconds, quiet, per-role agents)', async () => {
    await writeConfig(
      cwd,
      [
        'cockpit:',
        '  owner: alice',
        '  auto:',
        '    loop: { model: sonnet, effort: low }',
        '    heartbeatSeconds: 1200',
        '    quiet: true',
        '    agents:',
        '      default: { model: sonnet, effort: medium }',
        '      reviewer: { model: opus, effort: high }',
        '      validator: { model: haiku }',
        '',
      ].join('\n'),
    );
    const result = await loadCockpitConfig({ cwd, whoami: async () => null });
    expect(result.warnings).toEqual([]);
    expect(result.config.auto).toEqual({
      loop: { model: 'sonnet', effort: 'low' },
      heartbeatSeconds: 1200,
      quiet: true,
      agents: {
        default: { model: 'sonnet', effort: 'medium' },
        reviewer: { model: 'opus', effort: 'high' },
        validator: { model: 'haiku' },
      },
    });
  });

  it('auto block alone yields source cockpit-block', async () => {
    await writeConfig(cwd, 'cockpit:\n  auto:\n    quiet: true\n');
    const result = await loadCockpitConfig({ cwd, whoami: async () => null });
    expect(result.source).toBe('cockpit-block');
    expect(result.config.auto?.quiet).toBe(true);
  });

  it('invalid cockpit.auto degrades to a warning without breaking owner/assignee', async () => {
    await writeConfig(
      cwd,
      [
        'cockpit:',
        '  owner: alice',
        '  auto:',
        '    heartbeatSeconds: 5',
        '    agents:',
        '      reviewre: { model: opus }',
        '',
      ].join('\n'),
    );
    const result = await loadCockpitConfig({ cwd, whoami: async () => null });
    expect(result.config.owner).toBe('alice');
    expect(result.config.auto).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('cockpit.auto ignored (invalid)');
  });

  it('unknown effort value in cockpit.auto is rejected (warning), valid entries unaffected elsewhere', async () => {
    await writeConfig(
      cwd,
      'cockpit:\n  auto:\n    loop: { model: sonnet, effort: turbo }\n',
    );
    const result = await loadCockpitConfig({ cwd, whoami: async () => null });
    expect(result.config.auto).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it('absent auto block leaves config.auto undefined with no warnings', async () => {
    await writeConfig(cwd, 'cockpit:\n  owner: alice\n');
    const result = await loadCockpitConfig({ cwd, whoami: async () => null });
    expect(result.config.auto).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});
