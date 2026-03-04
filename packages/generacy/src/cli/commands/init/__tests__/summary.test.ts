import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileResult } from '../types.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts
// ---------------------------------------------------------------------------

const mockLogWarn = vi.fn();
const mockLogStep = vi.fn();
const mockLogSuccess = vi.fn();
const mockLogInfo = vi.fn();
const mockNote = vi.fn();

vi.mock('@clack/prompts', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    step: (...args: unknown[]) => mockLogStep(...args),
    success: (...args: unknown[]) => mockLogSuccess(...args),
    info: (...args: unknown[]) => mockLogInfo(...args),
  },
  note: (...args: unknown[]) => mockNote(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { printSummary, printNextSteps } from '../summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: '.generacy/config.yaml',
    action: 'created',
    size: 245,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe('printSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty results
  // -------------------------------------------------------------------------

  describe('empty results', () => {
    it('warns when no files were generated', () => {
      printSummary([], false, 'standard');

      expect(mockLogWarn).toHaveBeenCalledWith('No files were generated.');
    });

    it('does not print file lines or totals for empty results', () => {
      printSummary([], false, 'standard');

      expect(mockLogStep).not.toHaveBeenCalled();
      expect(mockLogSuccess).not.toHaveBeenCalled();
      expect(mockLogInfo).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Normal mode (dryRun = false)
  // -------------------------------------------------------------------------

  describe('normal mode', () => {
    it('prints each file result with correct action label', () => {
      const results: FileResult[] = [
        makeResult({ path: '.generacy/config.yaml', action: 'created', size: 100 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogStep).toHaveBeenCalledTimes(1);
      expect(mockLogStep).toHaveBeenCalledWith(expect.stringContaining('Created'));
      expect(mockLogStep).toHaveBeenCalledWith(expect.stringContaining('.generacy/config.yaml'));
    });

    it('uses all normal-mode labels correctly', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
        makeResult({ path: 'b.txt', action: 'overwritten', size: 20 }),
        makeResult({ path: 'c.txt', action: 'merged', size: 30 }),
        makeResult({ path: 'd.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, false, 'standard');

      const calls = mockLogStep.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls[0]).toContain('Created');
      expect(calls[1]).toContain('Overwritten');
      expect(calls[2]).toContain('Merged');
      expect(calls[3]).toContain('Skipped');
    });

    it('prints success totals line', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockLogSuccess).toHaveBeenCalledWith('Done: 1 created');
    });

    it('includes all non-zero counts in totals', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
        makeResult({ path: 'b.txt', action: 'created', size: 20 }),
        makeResult({ path: 'c.txt', action: 'overwritten', size: 30 }),
        makeResult({ path: 'd.txt', action: 'merged', size: 40 }),
        makeResult({ path: 'e.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogSuccess).toHaveBeenCalledWith(
        'Done: 2 created, 1 overwritten, 1 merged, 1 skipped',
      );
    });

    it('omits zero counts from totals', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
        makeResult({ path: 'b.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogSuccess).toHaveBeenCalledWith('Done: 1 created, 1 skipped');
    });
  });

  // -------------------------------------------------------------------------
  // Dry-run mode (dryRun = true)
  // -------------------------------------------------------------------------

  describe('dry-run mode', () => {
    it('uses dry-run action labels', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
        makeResult({ path: 'b.txt', action: 'overwritten', size: 20 }),
        makeResult({ path: 'c.txt', action: 'merged', size: 30 }),
        makeResult({ path: 'd.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, true, 'standard');

      const calls = mockLogStep.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls[0]).toContain('Would create');
      expect(calls[1]).toContain('Would overwrite');
      expect(calls[2]).toContain('Would merge');
      expect(calls[3]).toContain('Would skip');
    });

    it('prints dry-run info totals line', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
      ];

      printSummary(results, true, 'standard');

      // Called twice: once for variant label, once for dry-run totals
      expect(mockLogInfo).toHaveBeenCalledTimes(2);
      expect(mockLogInfo).toHaveBeenCalledWith(
        'Dry run: 1 created (no files were written)',
      );
    });

    it('does not call log.success in dry-run mode', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
      ];

      printSummary(results, true, 'standard');

      expect(mockLogSuccess).not.toHaveBeenCalled();
    });

    it('includes all non-zero counts in dry-run totals', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),
        makeResult({ path: 'b.txt', action: 'merged', size: 30 }),
        makeResult({ path: 'c.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, true, 'standard');

      expect(mockLogInfo).toHaveBeenCalledWith(
        'Dry run: 1 created, 1 merged, 1 skipped (no files were written)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Size formatting
  // -------------------------------------------------------------------------

  describe('size formatting', () => {
    it('shows bytes for files under 1 KB', () => {
      const results: FileResult[] = [
        makeResult({ path: 'small.txt', action: 'created', size: 500 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogStep).toHaveBeenCalledWith(expect.stringContaining('(500 bytes)'));
    });

    it('shows KB for files at exactly 1024 bytes', () => {
      const results: FileResult[] = [
        makeResult({ path: 'exact.txt', action: 'created', size: 1024 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogStep).toHaveBeenCalledWith(expect.stringContaining('(1.0 KB)'));
    });

    it('shows KB with one decimal for files over 1 KB', () => {
      const results: FileResult[] = [
        makeResult({ path: 'large.txt', action: 'created', size: 1536 }),
      ];

      printSummary(results, false, 'standard');

      expect(mockLogStep).toHaveBeenCalledWith(expect.stringContaining('(1.5 KB)'));
    });

    it('omits size for zero-byte (skipped) files', () => {
      const results: FileResult[] = [
        makeResult({ path: 'skipped.txt', action: 'skipped', size: 0 }),
      ];

      printSummary(results, false, 'standard');

      const call = mockLogStep.mock.calls[0]![0] as string;
      expect(call).not.toContain('bytes');
      expect(call).not.toContain('KB');
    });
  });

  // -------------------------------------------------------------------------
  // Label alignment
  // -------------------------------------------------------------------------

  describe('label alignment', () => {
    it('pads shorter labels to match the longest label', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'created', size: 10 }),     // "Created" (7)
        makeResult({ path: 'b.txt', action: 'overwritten', size: 20 }), // "Overwritten" (11)
      ];

      printSummary(results, false, 'standard');

      const calls = mockLogStep.mock.calls.map((c: unknown[]) => c[0] as string);
      // "Created" should be padded to 11 chars ("Overwritten" length)
      expect(calls[0]).toMatch(/^Created {4} {2}a\.txt/);
      expect(calls[1]).toMatch(/^Overwritten {2}b\.txt/);
    });

    it('pads dry-run labels correctly', () => {
      const results: FileResult[] = [
        makeResult({ path: 'a.txt', action: 'merged', size: 10 }),      // "Would merge" (11)
        makeResult({ path: 'b.txt', action: 'overwritten', size: 20 }), // "Would overwrite" (15)
      ];

      printSummary(results, true, 'standard');

      const calls = mockLogStep.mock.calls.map((c: unknown[]) => c[0] as string);
      // "Would merge" (11) padded to 15 ("Would overwrite" length)
      expect(calls[0]).toMatch(/^Would merge {4} {2}a\.txt/);
      expect(calls[1]).toMatch(/^Would overwrite {2}b\.txt/);
    });
  });
});

// ---------------------------------------------------------------------------
// printNextSteps
// ---------------------------------------------------------------------------

describe('printNextSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints all five guidance steps', () => {
    printNextSteps();

    expect(mockNote).toHaveBeenCalledTimes(1);
    const body = mockNote.mock.calls[0]![0] as string;
    expect(body).toContain('1. Review the generated files');
    expect(body).toContain('2. Copy .devcontainer/.env.template to .devcontainer/.env and fill in credentials');
    expect(body).toContain('3. Copy .generacy/generacy.env.template to .generacy/generacy.env and fill in credentials');
    expect(body).toContain('4. Run `generacy doctor` to verify system requirements');
    expect(body).toContain('5. Commit the generated files to your repository');
  });

  it('uses "Next steps" as the note title', () => {
    printNextSteps();

    expect(mockNote).toHaveBeenCalledWith(expect.any(String), 'Next steps');
  });

  it('joins steps with newline separators', () => {
    printNextSteps();

    const body = mockNote.mock.calls[0]![0] as string;
    const lines = body.split('\n');
    expect(lines).toHaveLength(5);
  });
});
