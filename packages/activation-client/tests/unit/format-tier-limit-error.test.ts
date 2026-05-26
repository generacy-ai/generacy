import { describe, it, expect } from 'vitest';
import { formatTierLimitError } from '../../src/format-tier-limit-error.js';

describe('formatTierLimitError', () => {
  it('formats basic tier with exact message body', () => {
    expect(formatTierLimitError({ requested: 8, cap: 4, tier: 'basic' })).toBe(
      'Worker count of 8 exceeds your Basic plan limit of 4. Upgrade your plan or retry with --workers=4.',
    );
  });

  it('formats pro tier with exact message body', () => {
    expect(formatTierLimitError({ requested: 16, cap: 8, tier: 'pro' })).toBe(
      'Worker count of 16 exceeds your Pro plan limit of 8. Upgrade your plan or retry with --workers=8.',
    );
  });

  it('formats enterprise tier with exact message body', () => {
    expect(
      formatTierLimitError({ requested: 32, cap: 16, tier: 'enterprise' }),
    ).toBe(
      'Worker count of 32 exceeds your Enterprise plan limit of 16. Upgrade your plan or retry with --workers=16.',
    );
  });

  it('title-cases only the first character (multi-word tier degrades gracefully)', () => {
    expect(formatTierLimitError({ requested: 4, cap: 2, tier: 'pro-plus' })).toBe(
      'Worker count of 4 exceeds your Pro-plus plan limit of 2. Upgrade your plan or retry with --workers=2.',
    );
  });

  it('handles zero cap boundary', () => {
    expect(formatTierLimitError({ requested: 4, cap: 0, tier: 'basic' })).toBe(
      'Worker count of 4 exceeds your Basic plan limit of 0. Upgrade your plan or retry with --workers=0.',
    );
  });

  it('handles empty tier (degenerate, degrades acceptably)', () => {
    expect(formatTierLimitError({ requested: 5, cap: 2, tier: '' })).toBe(
      'Worker count of 5 exceeds your plan limit of 2. Upgrade your plan or retry with --workers=2.',
    );
  });

  it('does not produce double spaces when tier is empty (regression for #728)', () => {
    const result = formatTierLimitError({ requested: 5, cap: 2, tier: '' });
    expect(result).not.toContain('  ');
  });

  it('is pure (identical input yields strict-equal output)', () => {
    const input = { requested: 8, cap: 4, tier: 'basic' };
    expect(formatTierLimitError(input)).toBe(formatTierLimitError(input));
  });
});
