import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveGeneracyDir, resetGeneracyDirCache } from '../../src/services/project-dir-resolver.js';

describe('resolveGeneracyDir', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetGeneracyDirCache();
    delete process.env['GENERACY_PROJECT_DIR'];
    delete process.env['WORKSPACE_DIR'];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('tier 1: returns GENERACY_PROJECT_DIR/.generacy when set', async () => {
    process.env['GENERACY_PROJECT_DIR'] = '/my/project';
    const result = await resolveGeneracyDir();
    expect(result).toBe(path.resolve('/my/project', '.generacy'));
  });

  it('tier 2: returns WORKSPACE_DIR/.generacy when GENERACY_PROJECT_DIR is unset', async () => {
    process.env['WORKSPACE_DIR'] = '/workspaces/my-project';
    const result = await resolveGeneracyDir();
    expect(result).toBe(path.resolve('/workspaces/my-project', '.generacy'));
  });

  it('tier 3: discovers single .generacy/cluster.yaml under /workspaces', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdir').mockResolvedValue([
      { name: 'my-project', isDirectory: () => true, isFile: () => false } as any,
      { name: 'other-dir', isDirectory: () => true, isFile: () => false } as any,
    ] as any);

    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p) => {
      if (String(p) === '/workspaces/my-project/.generacy/cluster.yaml') {
        return {} as any;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await resolveGeneracyDir();
    expect(result).toBe('/workspaces/my-project/.generacy');
    expect(readdirSpy).toHaveBeenCalledWith('/workspaces', { withFileTypes: true });
  });

  it('tier 3: multiple matches warn and fall through to tier 4', async () => {
    vi.spyOn(fs, 'readdir').mockResolvedValue([
      { name: 'project-a', isDirectory: () => true, isFile: () => false } as any,
      { name: 'project-b', isDirectory: () => true, isFile: () => false } as any,
    ] as any);

    vi.spyOn(fs, 'stat').mockResolvedValue({} as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveGeneracyDir();
    expect(result).toBe(path.resolve(process.cwd(), '.generacy'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('multiple .generacy dirs found'),
    );
  });

  it('tier 3: zero matches fall through to tier 4', async () => {
    vi.spyOn(fs, 'readdir').mockResolvedValue([
      { name: 'no-generacy', isDirectory: () => true, isFile: () => false } as any,
    ] as any);

    vi.spyOn(fs, 'stat').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const result = await resolveGeneracyDir();
    expect(result).toBe(path.resolve(process.cwd(), '.generacy'));
  });

  it('tier 4: /workspaces not readable falls through to CWD', async () => {
    vi.spyOn(fs, 'readdir').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const result = await resolveGeneracyDir();
    expect(result).toBe(path.resolve(process.cwd(), '.generacy'));
  });

  it('caches result after first resolution', async () => {
    process.env['GENERACY_PROJECT_DIR'] = '/cached/project';
    const first = await resolveGeneracyDir();

    // Change env — should still return cached value
    process.env['GENERACY_PROJECT_DIR'] = '/different/project';
    const second = await resolveGeneracyDir();

    expect(first).toBe(second);
    expect(second).toBe(path.resolve('/cached/project', '.generacy'));
  });

  it('resetGeneracyDirCache clears the cache', async () => {
    process.env['GENERACY_PROJECT_DIR'] = '/first';
    const first = await resolveGeneracyDir();

    resetGeneracyDirCache();
    process.env['GENERACY_PROJECT_DIR'] = '/second';
    const second = await resolveGeneracyDir();

    expect(first).toBe(path.resolve('/first', '.generacy'));
    expect(second).toBe(path.resolve('/second', '.generacy'));
  });
});
