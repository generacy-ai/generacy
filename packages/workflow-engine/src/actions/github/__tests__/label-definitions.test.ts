/**
 * FR-002 / SC-002: Static description-length invariant.
 *
 * GitHub's `createLabel` rejects descriptions >100 chars with HTTP 422. A future
 * entry that violates the limit would silently 422 on every worker's ensure-pass
 * and leak into apply-time 404s (issue #916 root cause). This parameterized test
 * blocks CI on any such regression.
 */
import { describe, it, expect } from 'vitest';
import { WORKFLOW_LABELS } from '../label-definitions.js';

describe('WORKFLOW_LABELS description-length invariant (FR-002)', () => {
  describe.each(WORKFLOW_LABELS)('$name', (label) => {
    it('has description ≤100 chars', () => {
      expect(label.description.length).toBeLessThanOrEqual(100);
    });
  });

  it('all entries satisfy the description-length invariant', () => {
    expect(WORKFLOW_LABELS.every((l) => l.description.length <= 100)).toBe(true);
  });
});
