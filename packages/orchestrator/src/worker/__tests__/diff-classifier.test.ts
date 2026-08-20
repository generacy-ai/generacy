import { describe, expect, it } from 'vitest';
import { classifyDiff, isTestFile } from '../diff-classifier.js';

describe('classifyDiff (#1134 SC-001 — every branch + guard)', () => {
  it('1. empty diff → full-fallback (empty-diff)', () => {
    expect(classifyDiff({ changedFiles: [], isWorkspace: true })).toEqual({
      kind: 'full-fallback',
      reason: 'empty-diff',
    });
  });

  it('2. lockfile touched (+ other src) → full-fallback', () => {
    const result = classifyDiff({
      changedFiles: ['pnpm-lock.yaml', 'packages/a/src/x.ts'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'full-fallback', reason: 'root-config: pnpm-lock.yaml' });
  });

  it('3. pnpm-workspace.yaml touched → full-fallback', () => {
    const result = classifyDiff({ changedFiles: ['pnpm-workspace.yaml'], isWorkspace: true });
    expect(result).toEqual({ kind: 'full-fallback', reason: 'root-config: pnpm-workspace.yaml' });
  });

  it('4a. root tsconfig.json touched → full-fallback', () => {
    const result = classifyDiff({ changedFiles: ['tsconfig.json'], isWorkspace: true });
    expect(result).toEqual({ kind: 'full-fallback', reason: 'root-config: tsconfig.json' });
  });

  it('4b. nested packages/x/tsconfig.json → NOT full-fallback (targeted)', () => {
    const result = classifyDiff({
      changedFiles: ['packages/x/tsconfig.json', 'packages/x/src/x.ts'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'targeted' });
  });

  it('5. .github/workflows/ci.yml touched → full-fallback', () => {
    const result = classifyDiff({
      changedFiles: ['.github/workflows/ci.yml'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'full-fallback', reason: 'root-config: .github/workflows/ci.yml' });
  });

  it('6. isWorkspace:false with package source → single-package-plain', () => {
    const result = classifyDiff({ changedFiles: ['src/index.ts'], isWorkspace: false });
    expect(result).toEqual({ kind: 'single-package-plain', reason: 'not-a-workspace' });
  });

  it('7. all docs (*.md and under docs/) → docs-only-skip-tests', () => {
    const result = classifyDiff({
      changedFiles: ['README.md', 'docs/guide/x.txt', 'packages/a/CHANGELOG.md'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'docs-only-skip-tests' });
  });

  it('8. mixed docs + source → targeted (not docs-only)', () => {
    const result = classifyDiff({
      changedFiles: ['README.md', 'packages/a/src/x.ts'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'targeted' });
  });

  it('9. all test (*.test.ts / __tests__/**) → test-only with testFiles', () => {
    const changedFiles = ['packages/a/src/x.test.ts', 'packages/a/src/__tests__/y.ts'];
    const result = classifyDiff({ changedFiles, isWorkspace: true });
    expect(result).toEqual({ kind: 'test-only', testFiles: changedFiles });
  });

  it('10. mixed test + source → targeted (not test-only)', () => {
    const result = classifyDiff({
      changedFiles: ['packages/a/src/x.test.ts', 'packages/a/src/x.ts'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'targeted' });
  });

  it('11. plain package source on a workspace → targeted', () => {
    const result = classifyDiff({
      changedFiles: ['packages/a/src/x.ts', 'packages/b/src/y.ts'],
      isWorkspace: true,
    });
    expect(result).toEqual({ kind: 'targeted' });
  });

  it('is pure — identical input yields identical output', () => {
    const input = { changedFiles: ['packages/a/src/x.ts'], isWorkspace: true };
    expect(classifyDiff(input)).toEqual(classifyDiff(input));
  });
});

describe('isTestFile predicate', () => {
  it('matches *.{test,spec}.{ts,tsx,js,jsx} and __tests__/', () => {
    expect(isTestFile('a/b.test.ts')).toBe(true);
    expect(isTestFile('a/b.spec.tsx')).toBe(true);
    expect(isTestFile('a/b.test.js')).toBe(true);
    expect(isTestFile('a/__tests__/b.ts')).toBe(true);
    expect(isTestFile('a/b.ts')).toBe(false);
    expect(isTestFile('README.md')).toBe(false);
  });
});
