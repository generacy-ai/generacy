import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveManifestPath } from '../manifest/resolve-manifest-path.js';

describe('resolveManifestPath', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cockpit-resolve-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns `not-found` when the dir is empty', async () => {
    const result = await resolveManifestPath({ manifestRoot: root });
    expect(result).toEqual({ kind: 'not-found', root });
  });

  it('returns `ok` with the path when exactly one .yaml is present', async () => {
    await writeFile(join(root, 'cockpit.yaml'), 'placeholder', 'utf-8');
    const result = await resolveManifestPath({ manifestRoot: root });
    expect(result).toEqual({ kind: 'ok', path: join(root, 'cockpit.yaml') });
  });

  it('returns `ambiguous` with sorted matches when multiple .yaml files are present', async () => {
    await writeFile(join(root, 'b.yaml'), 'x', 'utf-8');
    await writeFile(join(root, 'a.yaml'), 'x', 'utf-8');
    const result = await resolveManifestPath({ manifestRoot: root });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.matches).toEqual(['a.yaml', 'b.yaml']);
    }
  });

  it('returns `not-found` when --epic points at a missing file', async () => {
    const result = await resolveManifestPath({ manifestRoot: root, epic: 'cockpit' });
    expect(result).toEqual({ kind: 'not-found', root });
  });

  it('returns `ok` when --epic points at an existing file', async () => {
    await writeFile(join(root, 'cockpit.yaml'), 'placeholder', 'utf-8');
    const result = await resolveManifestPath({ manifestRoot: root, epic: 'cockpit' });
    expect(result).toEqual({ kind: 'ok', path: join(root, 'cockpit.yaml') });
  });
});
