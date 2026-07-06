import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '../manifest/io.js';
import type { EpicManifest } from '../manifest/schema.js';

const SAMPLE: EpicManifest = {
  epic: {
    repo: 'generacy-ai/generacy',
    issue: 786,
    slug: 'epic-cockpit',
    plan: 'docs/epic-cockpit-plan.md',
  },
  autonomy: {},
  phases: [
    {
      name: 'foundation',
      tier: 'P0',
      repos: ['generacy-ai/generacy'],
      issues: ['generacy-ai/generacy#786'],
    },
    {
      name: 'ui',
      tier: 'P1',
      repos: ['generacy-ai/generacy-extension'],
      issues: [],
    },
  ],
};

describe('manifest io', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cockpit-manifest-'));
    path = join(dir, 'epic-cockpit.yaml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readManifest returns null on missing file', async () => {
    const result = await readManifest(join(dir, 'absent.yaml'));
    expect(result).toBeNull();
  });

  it('round-trips write → read', async () => {
    await writeManifest(path, SAMPLE);
    const reread = await readManifest(path);
    expect(reread).toEqual(SAMPLE);
  });

  it('writeManifest creates parent directories', async () => {
    const deep = join(dir, 'a', 'b', 'c', 'epic.yaml');
    await writeManifest(deep, SAMPLE);
    const reread = await readManifest(deep);
    expect(reread?.epic.issue).toBe(786);
  });

  it('writeManifest writes atomically (no leftover .tmp)', async () => {
    await writeManifest(path, SAMPLE);
    const reread = await readManifest(path);
    expect(reread).toEqual(SAMPLE);
    // .tmp should not survive
    const tmp = `${path}.tmp`;
    await expect(readFile(tmp, 'utf-8')).rejects.toThrow();
  });

  it('readManifest throws on malformed YAML', async () => {
    await writeFile(path, ': : :\n  -- bad', 'utf-8');
    await expect(readManifest(path)).rejects.toThrow(/Failed to parse YAML/);
  });

  it('readManifest throws on schema violation', async () => {
    await writeFile(path, 'epic:\n  repo: invalid\n', 'utf-8');
    await expect(readManifest(path)).rejects.toThrow();
  });

});
