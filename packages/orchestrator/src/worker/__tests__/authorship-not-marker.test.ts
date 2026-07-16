/**
 * #958 SC-003 / SC-007 — Structural / grep-based regression tests.
 *
 * The pre-#958 defect was authorship-by-content: L488 sniffed
 * `.includes('**Question**:')` to decide whether a comment was an answer
 * source. This test locks that regression out by asserting the sniff no
 * longer appears in the file. It also asserts the marker-allowlist is not
 * used as the sole authorship signal on the answer surface (SC-003).
 *
 * SC-007 is enforced by verifying no source file outside of the shared
 * constant / test fixtures spells the `*Pending*` literal or the legacy
 * `[Leave empty for now]` placeholder.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Repo root by walking up until we find `pnpm-workspace.yaml`. Vitest's cwd
 * is the package directory; the grep-based assertions want a stable anchor.
 */
function findRepoRoot(): string {
  let dir = resolve(__dirname);
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('could not find repo root — no pnpm-workspace.yaml above cwd');
    }
    dir = parent;
  }
  return dir;
}

const REPO_ROOT = findRepoRoot();
const POSTER = join(REPO_ROOT, 'packages/orchestrator/src/worker/clarification-poster.ts');

function readPoster(): string {
  return readFileSync(POSTER, 'utf-8');
}

describe('#958 SC-003 — authorship-by-content sniff removed', () => {
  it('clarification-poster.ts does not include `**Question**:` content-sniff branch', () => {
    // Grep: the only allowed reference to `**Question**:` is inside the
    // `isQuestionComment` helper for the questions-comment classifier
    // (which is a separate surface from the answer-scanner). Assert the
    // parseAnswersFromComments sniff is gone by requiring the L488
    // one-line pattern to be absent.
    const source = readPoster();
    // The removed line was:
    //   if (answer.includes('**Question**:') || answer.includes('**Context**:')) {
    // Ensure no `answer.includes('**Question**:')` remains.
    expect(source).not.toMatch(/answer\.includes\(['"]\*\*Question\*\*:['"]\)/);
    expect(source).not.toMatch(/answer\.includes\(['"]\*\*Context\*\*:['"]\)/);
  });

  it('viewerDidAuthor gate is the answer-scanner authorship signal', () => {
    const source = readPoster();
    // The FR-001 branch must be present — authorship gates integration.
    expect(source).toMatch(/viewerDidAuthor\s*===\s*true/);
    // And the marker requirement for cluster-self:
    expect(source).toMatch(/commentCarriesAnswerMarker\(/);
  });
});

describe('#958 SC-007 — single-source pending literal', () => {
  const ROOTS = [
    join(REPO_ROOT, 'packages/orchestrator/src'),
    join(REPO_ROOT, 'packages/workflow-engine/src'),
    join(REPO_ROOT, 'packages/generacy/src'),
  ];
  const EXCLUDE_DIRS = new Set(['__tests__', 'node_modules', 'dist']);
  const EXCLUDE_FILES = new Set(['pending-literal.ts']);

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry)) walk(full, out);
      } else if (s.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
        if (!EXCLUDE_FILES.has(entry)) out.push(full);
      }
    }
  }

  it('`*Pending*` and `[Leave empty for now]` literals appear only in pending-literal.ts (or its tests)', () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(root, files);
    const literalOffenders: string[] = [];
    const legacyOffenders: string[] = [];
    for (const f of files) {
      const contents = readFileSync(f, 'utf-8');
      if (contents.includes('*Pending*')) literalOffenders.push(f);
      if (contents.includes('[Leave empty for now]')) legacyOffenders.push(f);
    }
    // Zero divergent literals outside pending-literal.ts (excluded above).
    expect(literalOffenders).toEqual([]);
    expect(legacyOffenders).toEqual([]);
  });
});
