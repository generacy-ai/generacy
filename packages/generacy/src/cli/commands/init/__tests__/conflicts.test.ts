import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InitOptions, FileAction } from '../types.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts — capture select calls and cancel handling
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockIsCancel = vi.fn(() => false);
const mockCancel = vi.fn();

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
}));

// ---------------------------------------------------------------------------
// Mock diff — spy on createTwoFilesPatch
// ---------------------------------------------------------------------------

const mockCreateTwoFilesPatch = vi.fn(() => 'mock-diff-output');

vi.mock('diff', () => ({
  createTwoFilesPatch: (...args: unknown[]) => mockCreateTwoFilesPatch(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { checkConflicts, showDiff, resolveConflicts } from '../conflicts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal InitOptions with sensible defaults for testing. */
function makeOptions(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    projectId: null,
    projectName: 'test-project',
    primaryRepo: 'acme/app',
    devRepos: [],
    cloneRepos: [],
    agent: 'claude-code',
    baseBranch: 'main',
    releaseStream: 'stable',
    force: false,
    dryRun: false,
    skipGithubCheck: false,
    yes: false,
    verbose: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkConflicts
// ---------------------------------------------------------------------------

describe('checkConflicts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conflicts-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty map when no files exist on disk', () => {
    const files = new Map([
      ['.generacy/config.yaml', 'schema: 1'],
      ['.devcontainer/devcontainer.json', '{}'],
    ]);

    const conflicts = checkConflicts(files, tempDir);

    expect(conflicts.size).toBe(0);
  });

  it('detects existing files and returns their content', () => {
    // Create an existing file on disk
    mkdirSync(join(tempDir, '.generacy'), { recursive: true });
    writeFileSync(join(tempDir, '.generacy/config.yaml'), 'existing-content');

    const files = new Map([
      ['.generacy/config.yaml', 'new-content'],
      ['.devcontainer/devcontainer.json', '{}'],
    ]);

    const conflicts = checkConflicts(files, tempDir);

    expect(conflicts.size).toBe(1);
    expect(conflicts.get('.generacy/config.yaml')).toBe('existing-content');
  });

  it('detects multiple conflicting files', () => {
    mkdirSync(join(tempDir, '.generacy'), { recursive: true });
    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(join(tempDir, '.generacy/config.yaml'), 'old-config');
    writeFileSync(join(tempDir, '.vscode/extensions.json'), '{"recommendations":[]}');

    const files = new Map([
      ['.generacy/config.yaml', 'new-config'],
      ['.vscode/extensions.json', '{"recommendations":["ext.new"]}'],
      ['.devcontainer/devcontainer.json', '{}'],
    ]);

    const conflicts = checkConflicts(files, tempDir);

    expect(conflicts.size).toBe(2);
    expect(conflicts.has('.generacy/config.yaml')).toBe(true);
    expect(conflicts.has('.vscode/extensions.json')).toBe(true);
    expect(conflicts.has('.devcontainer/devcontainer.json')).toBe(false);
  });

  it('handles unreadable files gracefully (no error thrown)', () => {
    // Create a directory where a file is expected — readFileSync will fail
    mkdirSync(join(tempDir, '.generacy'), { recursive: true });
    mkdirSync(join(tempDir, '.generacy/config.yaml'), { recursive: true }); // directory, not file

    const files = new Map([
      ['.generacy/config.yaml', 'new-content'],
    ]);

    // Should not throw — treats unreadable as non-conflicting
    const conflicts = checkConflicts(files, tempDir);

    expect(conflicts.size).toBe(0);
  });

  it('returns empty map when files map is empty', () => {
    const files = new Map<string, string>();

    const conflicts = checkConflicts(files, tempDir);

    expect(conflicts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// showDiff
// ---------------------------------------------------------------------------

describe('showDiff', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCreateTwoFilesPatch.mockReset();
    mockCreateTwoFilesPatch.mockReturnValue('mock-diff-output');
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('calls createTwoFilesPatch with correct arguments', () => {
    showDiff('.generacy/config.yaml', 'old content', 'new content');

    expect(mockCreateTwoFilesPatch).toHaveBeenCalledWith(
      'a/.generacy/config.yaml',
      'b/.generacy/config.yaml',
      'old content',
      'new content',
      'existing',
      'generated',
      { context: 3 },
    );
  });

  it('prints the diff output to console.log', () => {
    mockCreateTwoFilesPatch.mockReturnValue('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new');

    showDiff('file.txt', 'old', 'new');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new',
    );
  });

  it('uses a/ and b/ prefixes in diff headers', () => {
    showDiff('.vscode/settings.json', '{}', '{"key":"val"}');

    expect(mockCreateTwoFilesPatch).toHaveBeenCalledWith(
      'a/.vscode/settings.json',
      'b/.vscode/settings.json',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveConflicts
// ---------------------------------------------------------------------------

describe('resolveConflicts', () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockIsCancel.mockReset();
    mockCancel.mockReset();
    mockCreateTwoFilesPatch.mockReset();
    mockCreateTwoFilesPatch.mockReturnValue('mock-diff-output');
    mockIsCancel.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // No conflicts
  // -------------------------------------------------------------------------

  describe('no conflicts', () => {
    it('returns overwrite for all files when there are no conflicts', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'content-a'],
        ['.devcontainer/devcontainer.json', 'content-b'],
      ]);
      const conflicts = new Map<string, string>();

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.size).toBe(2);
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(actions.get('.devcontainer/devcontainer.json')).toBe('overwrite');
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // --force flag
  // -------------------------------------------------------------------------

  describe('--force flag', () => {
    it('returns overwrite for all files including conflicts', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'new-content'],
        ['.devcontainer/devcontainer.json', 'new-content'],
        ['new-file.txt', 'new-content'],
      ]);
      const conflicts = new Map([
        ['.generacy/config.yaml', 'old-content'],
        ['.devcontainer/devcontainer.json', 'old-content'],
      ]);

      const actions = await resolveConflicts(
        files,
        conflicts,
        makeOptions({ force: true }),
      );

      expect(actions.size).toBe(3);
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(actions.get('.devcontainer/devcontainer.json')).toBe('overwrite');
      expect(actions.get('new-file.txt')).toBe('overwrite');
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Smart merge files
  // -------------------------------------------------------------------------

  describe('smart merge files', () => {
    it('auto-merges .vscode/extensions.json without prompting', async () => {
      const files = new Map([
        ['.vscode/extensions.json', '{"recommendations":["ext.new"]}'],
        ['.generacy/config.yaml', 'new-config'],
      ]);
      const conflicts = new Map([
        ['.vscode/extensions.json', '{"recommendations":["ext.old"]}'],
      ]);

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('.vscode/extensions.json')).toBe('merge');
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('auto-merges .vscode/extensions.json even without --force', async () => {
      const files = new Map([
        ['.vscode/extensions.json', 'new'],
        ['.generacy/config.yaml', 'new'],
      ]);
      const conflicts = new Map([
        ['.vscode/extensions.json', 'old'],
        ['.generacy/config.yaml', 'old'],
      ]);

      // Prompt for the non-merge conflict
      mockSelect.mockResolvedValueOnce('overwrite');

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('.vscode/extensions.json')).toBe('merge');
      // Only one prompt — for .generacy/config.yaml, not extensions.json
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Interactive prompting
  // -------------------------------------------------------------------------

  describe('interactive prompting', () => {
    it('prompts for each conflicting file and respects overwrite choice', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'new-content'],
      ]);
      const conflicts = new Map([
        ['.generacy/config.yaml', 'old-content'],
      ]);

      mockSelect.mockResolvedValueOnce('overwrite');

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('.generacy/config.yaml'),
        }),
      );
    });

    it('respects skip choice', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'new-content'],
      ]);
      const conflicts = new Map([
        ['.generacy/config.yaml', 'old-content'],
      ]);

      mockSelect.mockResolvedValueOnce('skip');

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('.generacy/config.yaml')).toBe('skip');
    });

    it('prompts for multiple conflicting files independently', async () => {
      const files = new Map([
        ['.generacy/config.yaml', 'new-a'],
        ['.devcontainer/devcontainer.json', 'new-b'],
        ['new-file.txt', 'new-c'],
      ]);
      const conflicts = new Map([
        ['.generacy/config.yaml', 'old-a'],
        ['.devcontainer/devcontainer.json', 'old-b'],
      ]);

      mockSelect
        .mockResolvedValueOnce('overwrite')  // config.yaml
        .mockResolvedValueOnce('skip');       // devcontainer.json

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.size).toBe(3);
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(actions.get('.devcontainer/devcontainer.json')).toBe('skip');
      expect(actions.get('new-file.txt')).toBe('overwrite');
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it('provides overwrite/skip/diff options in the prompt', async () => {
      const files = new Map([['file.txt', 'new']]);
      const conflicts = new Map([['file.txt', 'old']]);

      mockSelect.mockResolvedValueOnce('overwrite');

      await resolveConflicts(files, conflicts, makeOptions());

      const selectCall = mockSelect.mock.calls[0]![0] as {
        options: Array<{ value: string; label: string }>;
      };
      const values = selectCall.options.map((o) => o.value);
      expect(values).toContain('overwrite');
      expect(values).toContain('skip');
      expect(values).toContain('diff');
    });
  });

  // -------------------------------------------------------------------------
  // Show diff → re-prompt flow
  // -------------------------------------------------------------------------

  describe('show diff flow', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('shows diff then re-prompts with only overwrite/skip', async () => {
      const files = new Map([['file.txt', 'new-content']]);
      const conflicts = new Map([['file.txt', 'old-content']]);

      mockSelect
        .mockResolvedValueOnce('diff')       // first prompt: show diff
        .mockResolvedValueOnce('overwrite');  // re-prompt: overwrite

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('file.txt')).toBe('overwrite');
      // Two select calls: initial prompt + re-prompt after diff
      expect(mockSelect).toHaveBeenCalledTimes(2);
      // The diff was displayed
      expect(mockCreateTwoFilesPatch).toHaveBeenCalledWith(
        'a/file.txt',
        'b/file.txt',
        'old-content',
        'new-content',
        'existing',
        'generated',
        { context: 3 },
      );
    });

    it('shows diff then allows skip on re-prompt', async () => {
      const files = new Map([['file.txt', 'new-content']]);
      const conflicts = new Map([['file.txt', 'old-content']]);

      mockSelect
        .mockResolvedValueOnce('diff')  // first prompt: show diff
        .mockResolvedValueOnce('skip'); // re-prompt: skip

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('file.txt')).toBe('skip');
      expect(mockSelect).toHaveBeenCalledTimes(2);
    });

    it('re-prompt only offers overwrite and skip (no diff option)', async () => {
      const files = new Map([['file.txt', 'new']]);
      const conflicts = new Map([['file.txt', 'old']]);

      mockSelect
        .mockResolvedValueOnce('diff')
        .mockResolvedValueOnce('overwrite');

      await resolveConflicts(files, conflicts, makeOptions());

      // Second call is the re-prompt — should only have overwrite/skip
      const rePromptCall = mockSelect.mock.calls[1]![0] as {
        options: Array<{ value: string; label: string }>;
      };
      const values = rePromptCall.options.map((o) => o.value);
      expect(values).toEqual(['overwrite', 'skip']);
      expect(values).not.toContain('diff');
    });
  });

  // -------------------------------------------------------------------------
  // Cancel handling
  // -------------------------------------------------------------------------

  describe('cancel handling', () => {
    it('exits with code 130 when initial prompt is cancelled', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const files = new Map([['file.txt', 'new']]);
      const conflicts = new Map([['file.txt', 'old']]);

      mockSelect.mockResolvedValueOnce(Symbol('cancel'));
      mockIsCancel.mockReturnValue(true);

      await expect(resolveConflicts(files, conflicts, makeOptions())).rejects.toThrow(
        'process.exit',
      );

      expect(mockCancel).toHaveBeenCalledWith('Operation cancelled.');
      expect(mockExit).toHaveBeenCalledWith(130);
      mockExit.mockRestore();
    });

    it('exits with code 130 when re-prompt after diff is cancelled', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const files = new Map([['file.txt', 'new']]);
      const conflicts = new Map([['file.txt', 'old']]);

      mockSelect
        .mockResolvedValueOnce('diff')                    // first: show diff
        .mockResolvedValueOnce(Symbol('cancel'));          // re-prompt: cancel
      mockIsCancel
        .mockReturnValueOnce(false)                        // first prompt not cancelled
        .mockReturnValueOnce(true);                        // re-prompt cancelled

      await expect(resolveConflicts(files, conflicts, makeOptions())).rejects.toThrow(
        'process.exit',
      );

      expect(mockCancel).toHaveBeenCalledWith('Operation cancelled.');
      expect(mockExit).toHaveBeenCalledWith(130);
      mockExit.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Mixed scenarios
  // -------------------------------------------------------------------------

  describe('mixed scenarios', () => {
    it('handles mix of new files, merge files, and prompted conflicts', async () => {
      const files = new Map([
        ['new-file.txt', 'brand-new'],
        ['.vscode/extensions.json', '{"recommendations":["ext.new"]}'],
        ['.generacy/config.yaml', 'new-config'],
        ['.devcontainer/devcontainer.json', 'new-dc'],
      ]);
      const conflicts = new Map([
        ['.vscode/extensions.json', '{"recommendations":["ext.old"]}'],
        ['.generacy/config.yaml', 'old-config'],
        ['.devcontainer/devcontainer.json', 'old-dc'],
      ]);

      mockSelect
        .mockResolvedValueOnce('overwrite')  // config.yaml
        .mockResolvedValueOnce('skip');       // devcontainer.json

      const actions = await resolveConflicts(files, conflicts, makeOptions());

      expect(actions.get('new-file.txt')).toBe('overwrite');           // new file
      expect(actions.get('.vscode/extensions.json')).toBe('merge');    // smart merge
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');  // user chose overwrite
      expect(actions.get('.devcontainer/devcontainer.json')).toBe('skip'); // user chose skip
      expect(actions.size).toBe(4);
    });

    it('force flag overrides smart merge to overwrite', async () => {
      const files = new Map([
        ['.vscode/extensions.json', 'new'],
        ['.generacy/config.yaml', 'new'],
      ]);
      const conflicts = new Map([
        ['.vscode/extensions.json', 'old'],
        ['.generacy/config.yaml', 'old'],
      ]);

      const actions = await resolveConflicts(
        files,
        conflicts,
        makeOptions({ force: true }),
      );

      // With --force, everything is overwrite (force takes precedence over merge)
      expect(actions.get('.vscode/extensions.json')).toBe('overwrite');
      expect(actions.get('.generacy/config.yaml')).toBe('overwrite');
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });
});
