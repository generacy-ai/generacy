import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileAction } from '../types.js';

// ---------------------------------------------------------------------------
// Mock logger — suppress debug output during tests
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { writeFiles, collectExistingFiles } from '../writer.js';

// ---------------------------------------------------------------------------
// writeFiles
// ---------------------------------------------------------------------------

describe('writeFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'writer-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic file writing
  // -------------------------------------------------------------------------

  describe('basic file writing', () => {
    it('writes files to correct paths relative to gitRoot', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'schema: 1'],
        ['.devcontainer/devcontainer.json', '{"name":"test"}'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
        ['.devcontainer/devcontainer.json', 'overwrite'],
      ]);

      await writeFiles(files, actions, tempDir, false);

      expect(existsSync(join(tempDir, '.generacy/config.yaml'))).toBe(true);
      expect(readFileSync(join(tempDir, '.generacy/config.yaml'), 'utf-8')).toBe('schema: 1');

      expect(existsSync(join(tempDir, '.devcontainer/devcontainer.json'))).toBe(true);
      expect(readFileSync(join(tempDir, '.devcontainer/devcontainer.json'), 'utf-8')).toBe(
        '{"name":"test"}',
      );
    });

    it('creates parent directories recursively', async () => {
      const files = new Map([
        ['deeply/nested/dir/file.txt', 'content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['deeply/nested/dir/file.txt', 'overwrite'],
      ]);

      await writeFiles(files, actions, tempDir, false);

      expect(existsSync(join(tempDir, 'deeply/nested/dir/file.txt'))).toBe(true);
      expect(readFileSync(join(tempDir, 'deeply/nested/dir/file.txt'), 'utf-8')).toBe('content');
    });

    it('writes content with correct encoding (utf-8)', async () => {
      const unicodeContent = '# Config\nname: "Ünïcödé Prøject" 🚀';
      const files = new Map([
        ['.generacy/config.yaml', unicodeContent],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
      ]);

      await writeFiles(files, actions, tempDir, false);

      expect(readFileSync(join(tempDir, '.generacy/config.yaml'), 'utf-8')).toBe(unicodeContent);
    });
  });

  // -------------------------------------------------------------------------
  // Dry-run mode
  // -------------------------------------------------------------------------

  describe('dry-run mode', () => {
    it('writes no files to disk when dryRun is true', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'schema: 1'],
        ['.devcontainer/devcontainer.json', '{}'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
        ['.devcontainer/devcontainer.json', 'overwrite'],
      ]);

      await writeFiles(files, actions, tempDir, true);

      expect(existsSync(join(tempDir, '.generacy/config.yaml'))).toBe(false);
      expect(existsSync(join(tempDir, '.devcontainer/devcontainer.json'))).toBe(false);
    });

    it('returns FileResult array with correct sizes in dry-run', async () => {
      const content = 'schema: 1';
      const files = new Map([
        ['.generacy/config.yaml', content],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, true);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        path: '.generacy/config.yaml',
        action: 'created',
        size: Buffer.byteLength(content, 'utf-8'),
      });
    });

    it('does not create parent directories in dry-run', async () => {
      const files = new Map([
        ['new-dir/sub-dir/file.txt', 'content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['new-dir/sub-dir/file.txt', 'overwrite'],
      ]);

      await writeFiles(files, actions, tempDir, true);

      expect(existsSync(join(tempDir, 'new-dir'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Skip action
  // -------------------------------------------------------------------------

  describe('skip action', () => {
    it('does not write files with skip action', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'new-content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'skip'],
      ]);

      await writeFiles(files, actions, tempDir, false);

      expect(existsSync(join(tempDir, '.generacy/config.yaml'))).toBe(false);
    });

    it('records skipped files with size 0', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'some content here'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'skip'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        path: '.generacy/config.yaml',
        action: 'skipped',
        size: 0,
      });
    });

    it('handles mix of skip and overwrite actions', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'config content'],
        ['.devcontainer/devcontainer.json', 'dc content'],
        ['.vscode/extensions.json', 'ext content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
        ['.devcontainer/devcontainer.json', 'skip'],
        ['.vscode/extensions.json', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      // Written files exist
      expect(existsSync(join(tempDir, '.generacy/config.yaml'))).toBe(true);
      expect(existsSync(join(tempDir, '.vscode/extensions.json'))).toBe(true);

      // Skipped file does not exist
      expect(existsSync(join(tempDir, '.devcontainer/devcontainer.json'))).toBe(false);

      // Results reflect actions
      expect(results).toHaveLength(3);
      expect(results.find((r) => r.path === '.devcontainer/devcontainer.json')).toEqual({
        path: '.devcontainer/devcontainer.json',
        action: 'skipped',
        size: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // FileResult correctness
  // -------------------------------------------------------------------------

  describe('FileResult array', () => {
    it('reports created for new files', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results[0]!.action).toBe('created');
    });

    it('reports overwritten for existing files with overwrite action', async () => {
      // Pre-create the file
      mkdirSync(join(tempDir, '.generacy'), { recursive: true });
      writeFileSync(join(tempDir, '.generacy/config.yaml'), 'old content');

      const files = new Map([
        ['.generacy/config.yaml', 'new content'],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results[0]!.action).toBe('overwritten');
      expect(readFileSync(join(tempDir, '.generacy/config.yaml'), 'utf-8')).toBe('new content');
    });

    it('reports merged for files with merge action', async () => {
      // Pre-create the file (merge implies pre-existing)
      mkdirSync(join(tempDir, '.vscode'), { recursive: true });
      writeFileSync(join(tempDir, '.vscode/extensions.json'), '{"recommendations":[]}');

      const mergedContent = '{"recommendations":["ext.old","ext.new"]}';
      const files = new Map([
        ['.vscode/extensions.json', mergedContent],
      ]);
      const actions = new Map<string, FileAction>([
        ['.vscode/extensions.json', 'merge'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results[0]!.action).toBe('merged');
      expect(readFileSync(join(tempDir, '.vscode/extensions.json'), 'utf-8')).toBe(mergedContent);
    });

    it('reports correct byte sizes for each file', async () => {
      const configContent = 'schema: 1\nname: test';
      const dcContent = '{"name":"devcontainer","image":"base"}';
      const files = new Map([
        ['.generacy/config.yaml', configContent],
        ['.devcontainer/devcontainer.json', dcContent],
      ]);
      const actions = new Map<string, FileAction>([
        ['.generacy/config.yaml', 'overwrite'],
        ['.devcontainer/devcontainer.json', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      const configResult = results.find((r) => r.path === '.generacy/config.yaml');
      const dcResult = results.find((r) => r.path === '.devcontainer/devcontainer.json');

      expect(configResult!.size).toBe(Buffer.byteLength(configContent, 'utf-8'));
      expect(dcResult!.size).toBe(Buffer.byteLength(dcContent, 'utf-8'));
    });

    it('returns results for all files in the input map', async () => {
      const files = new Map([
        ['file-a.txt', 'aaa'],
        ['file-b.txt', 'bbb'],
        ['file-c.txt', 'ccc'],
      ]);
      const actions = new Map<string, FileAction>([
        ['file-a.txt', 'overwrite'],
        ['file-b.txt', 'skip'],
        ['file-c.txt', 'overwrite'],
      ]);

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.path)).toEqual(['file-a.txt', 'file-b.txt', 'file-c.txt']);
    });
  });

  // -------------------------------------------------------------------------
  // Default action fallback
  // -------------------------------------------------------------------------

  describe('default action fallback', () => {
    it('defaults to overwrite when action is missing from the map', async () => {
      const files = new Map([
        ['file.txt', 'content'],
      ]);
      // Empty actions map — no explicit action for 'file.txt'
      const actions = new Map<string, FileAction>();

      const results = await writeFiles(files, actions, tempDir, false);

      expect(existsSync(join(tempDir, 'file.txt'))).toBe(true);
      expect(results[0]!.action).toBe('created');
    });
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  describe('empty input', () => {
    it('returns empty array when files map is empty', async () => {
      const files = new Map<string, string>();
      const actions = new Map<string, FileAction>();

      const results = await writeFiles(files, actions, tempDir, false);

      expect(results).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// collectExistingFiles
// ---------------------------------------------------------------------------

describe('collectExistingFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'collect-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads .vscode/extensions.json when present', () => {
    const extensionsContent = '{"recommendations":["ext.one","ext.two"]}';
    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(join(tempDir, '.vscode/extensions.json'), extensionsContent);

    const existing = collectExistingFiles(tempDir);

    expect(existing.size).toBe(1);
    expect(existing.get('.vscode/extensions.json')).toBe(extensionsContent);
  });

  it('returns empty map when .vscode/extensions.json does not exist', () => {
    const existing = collectExistingFiles(tempDir);

    expect(existing.size).toBe(0);
  });

  it('returns empty map when .vscode directory does not exist', () => {
    const existing = collectExistingFiles(tempDir);

    expect(existing.size).toBe(0);
  });

  it('handles unreadable files gracefully (returns empty map)', () => {
    // Create a directory where a file is expected — readFileSync will fail
    mkdirSync(join(tempDir, '.vscode/extensions.json'), { recursive: true });

    const existing = collectExistingFiles(tempDir);

    // The catch block in collectExistingFiles should handle the error
    expect(existing.size).toBe(0);
  });

  it('preserves exact file content including whitespace', () => {
    const contentWithWhitespace = '{\n  "recommendations": [\n    "ext.one"\n  ]\n}\n';
    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(join(tempDir, '.vscode/extensions.json'), contentWithWhitespace);

    const existing = collectExistingFiles(tempDir);

    expect(existing.get('.vscode/extensions.json')).toBe(contentWithWhitespace);
  });
});
