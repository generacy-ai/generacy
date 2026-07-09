/**
 * SC-005 audit test (#869): asserts that the two production PR-feedback
 * call sites (`pr-feedback-monitor-service.ts`, `pr-feedback-handler.ts`)
 *
 * 1. Import `isTrustedCommentAuthor` from `@generacy-ai/workflow-engine`
 *    exactly once each, and
 * 2. Do NOT contain any inline `authorAssociation === 'OWNER'` /
 *    `'MEMBER'` / `'COLLABORATOR'` string checks (all trust decisions
 *    must go through the shared predicate).
 *
 * This guards against regressions where a future contributor inlines a
 * tier check outside the shared predicate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const MONITOR_PATH = join(HERE, '../services/pr-feedback-monitor-service.ts');
const HANDLER_PATH = join(HERE, '../worker/pr-feedback-handler.ts');

function importOccurrenceCount(source: string, symbol: string): number {
  // Count import statements (single- or multi-line) that pull `symbol` from
  // `@generacy-ai/workflow-engine`. Handles the `import { … } from '…'` shape
  // across newlines.
  const re = /import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const body = match[1] ?? '';
    const module = match[2] ?? '';
    if (module === '@generacy-ai/workflow-engine' && body.includes(symbol)) {
      count++;
    }
  }
  return count;
}

describe('#869 SC-005: shared trust-predicate audit', () => {
  it('pr-feedback-monitor-service.ts imports isTrustedCommentAuthor exactly once', () => {
    const src = readFileSync(MONITOR_PATH, 'utf-8');
    expect(importOccurrenceCount(src, 'isTrustedCommentAuthor')).toBe(1);
  });

  it('pr-feedback-handler.ts imports isTrustedCommentAuthor exactly once', () => {
    const src = readFileSync(HANDLER_PATH, 'utf-8');
    expect(importOccurrenceCount(src, 'isTrustedCommentAuthor')).toBe(1);
  });

  it('neither file contains inline authorAssociation tier checks', () => {
    for (const p of [MONITOR_PATH, HANDLER_PATH]) {
      const src = readFileSync(p, 'utf-8');
      const forbiddenPatterns = [
        /authorAssociation\s*===\s*['"]OWNER['"]/,
        /authorAssociation\s*===\s*['"]MEMBER['"]/,
        /authorAssociation\s*===\s*['"]COLLABORATOR['"]/,
      ];
      for (const pat of forbiddenPatterns) {
        expect(src).not.toMatch(pat);
      }
    }
  });
});
