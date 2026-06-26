import { describe, expect, it } from 'vitest';
import { classifyChecks } from '../shared/required-checks.js';

describe('classifyChecks', () => {
  describe('branch-protection source', () => {
    it('returns ok=true when every required check is green', () => {
      const result = classifyChecks({
        required: { source: 'branch-protection', names: ['ci/lint', 'ci/test'] },
        actual: [
          { name: 'ci/lint', state: 'SUCCESS' },
          { name: 'ci/test', state: 'SUCCESS' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.failingChecks).toEqual([]);
    });

    it('synthesizes MISSING for required check absent from actual', () => {
      const result = classifyChecks({
        required: { source: 'branch-protection', names: ['ci/lint', 'ci/test'] },
        actual: [{ name: 'ci/lint', state: 'SUCCESS' }],
      });
      expect(result.ok).toBe(false);
      expect(result.failingChecks).toEqual([
        { name: 'ci/test', state: 'MISSING' },
      ]);
    });

    it('marks pending actual check as failing with PENDING state', () => {
      const result = classifyChecks({
        required: { source: 'branch-protection', names: ['ci/test'] },
        actual: [
          { name: 'ci/test', state: 'PENDING', url: 'https://x/1' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.failingChecks).toEqual([
        { name: 'ci/test', state: 'PENDING', url: 'https://x/1' },
      ]);
    });

    it('treats FAILURE as failing', () => {
      const result = classifyChecks({
        required: { source: 'branch-protection', names: ['ci/test'] },
        actual: [{ name: 'ci/test', state: 'FAILURE' }],
      });
      expect(result.failingChecks[0]?.state).toBe('FAILURE');
    });

    it('ignores extra actual checks not in required list', () => {
      const result = classifyChecks({
        required: { source: 'branch-protection', names: ['ci/lint'] },
        actual: [
          { name: 'ci/lint', state: 'SUCCESS' },
          { name: 'ci/extra', state: 'FAILURE' },
        ],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('fallback-pr-checks source', () => {
    it('returns ok=true when every PR check is green', () => {
      const result = classifyChecks({
        required: { source: 'fallback-pr-checks', names: null },
        actual: [
          { name: 'ci/lint', state: 'SUCCESS' },
          { name: 'ci/test', state: 'SUCCESS' },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('returns failing for any non-SUCCESS check', () => {
      const result = classifyChecks({
        required: { source: 'fallback-pr-checks', names: null },
        actual: [
          { name: 'ci/lint', state: 'SUCCESS' },
          { name: 'ci/test', state: 'FAILURE', url: 'https://x/2' },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.failingChecks).toEqual([
        { name: 'ci/test', state: 'FAILURE', url: 'https://x/2' },
      ]);
    });

    it('never synthesizes MISSING in fallback mode', () => {
      const result = classifyChecks({
        required: { source: 'fallback-pr-checks', names: null },
        actual: [],
      });
      expect(result.ok).toBe(true);
      expect(result.failingChecks).toEqual([]);
    });
  });
});
