import { describe, expect, it } from 'vitest';
import { extractPlan } from '../manifest/extract-plan.js';
import { isCockpitExit } from '../exit.js';

describe('extractPlan', () => {
  it('strips trailing ` in <repo>` and parenthesized suffix', () => {
    expect(
      extractPlan('Plan: docs/x.md in tetrad-development (P3 / G3.1)'),
    ).toBe('docs/x.md');
  });

  it('passes through a bare path', () => {
    expect(extractPlan('Plan: docs/x.md')).toBe('docs/x.md');
  });

  it('throws CockpitExit(2) when no `Plan:` line is present', () => {
    try {
      extractPlan('No plan here\n## Some header');
      throw new Error('expected throw');
    } catch (err) {
      expect(isCockpitExit(err)).toBe(true);
      const e = err as Error & { code: number };
      expect(e.code).toBe(2);
      expect(e.message).toMatch(/no "Plan:" line/);
    }
  });

  it('returns the first `Plan:` line when multiple are present', () => {
    const body = ['Plan: docs/first.md', 'Plan: docs/second.md'].join('\n');
    expect(extractPlan(body)).toBe('docs/first.md');
  });
});
