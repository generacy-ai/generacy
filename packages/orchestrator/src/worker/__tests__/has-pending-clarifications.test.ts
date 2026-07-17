/**
 * #958 SC-006 — `hasPendingClarifications` fail-closed regression.
 *
 * The pre-fix function returned `false` (== advance) on missing dir /
 * unreadable file / parse failure. FR-007 flips all three to `true`
 * (== pause). Legit empty file (`content.trim() === ''`) is the ONE
 * branch that returns `false`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { hasPendingClarifications } from '../clarification-poster.js';

const mockReaddirSync = vi.fn<(path: string) => string[]>();
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();

vi.mock('node:fs', () => ({
  readdirSync: (p: string) => mockReaddirSync(p),
  readFileSync: (p: string, e: string) => mockReadFileSync(p, e),
  writeFileSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#958 FR-007 — hasPendingClarifications fails closed', () => {
  it('missing spec directory → true (unknown ⇒ pause)', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(hasPendingClarifications('/tmp/no-checkout', 999)).toBe(true);
  });

  it('spec directory exists but no matching issue subdir → true', () => {
    mockReaddirSync.mockReturnValue(['1-something', '2-other']);
    // No 42-* subdir exists ⇒ findSpecDir returns undefined ⇒ pause.
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('readFileSync throws (unreadable / I/O error) → true', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('non-empty content with zero parsed questions → true (parse failure)', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockReturnValue('# Some markdown with no ### Q<n>: headings');
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('legit empty file (content.trim() === "") → false', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockReturnValue('   \n\n\t\n');
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('file with unanswered questions → true (baseline)', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockReturnValue(
      '# Clarification Questions\n\n### Q1: Foo\n**Question**: A?\n**Answer**: *Pending*\n',
    );
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });

  it('file with all questions answered → false', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockReturnValue(
      '# Clarification Questions\n\n### Q1: Foo\n**Question**: A?\n**Answer**: OAuth\n',
    );
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(false);
  });

  it('file with `[Leave empty for now]` placeholder → true (FR-012 tolerance)', () => {
    mockReaddirSync.mockReturnValue(['42-feature']);
    mockReadFileSync.mockReturnValue(
      '# Clarification Questions\n\n### Q1: Foo\n**Question**: A?\n**Answer**: [Leave empty for now]\n',
    );
    expect(hasPendingClarifications('/tmp/checkout', 42)).toBe(true);
  });
});
