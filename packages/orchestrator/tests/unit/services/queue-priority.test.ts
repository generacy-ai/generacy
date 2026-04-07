import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPriorityScore } from '../../../src/services/queue-priority.js';

describe('getPriorityScore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 0.{timestamp} for resume reason', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711036800000);
    const score = getPriorityScore('resume');
    expect(score).toBe(parseFloat('0.1711036800000'));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('should return 1.{timestamp} for retry reason', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711036800000);
    const score = getPriorityScore('retry');
    expect(score).toBe(parseFloat('1.1711036800000'));
    expect(score).toBeGreaterThan(1);
    expect(score).toBeLessThan(2);
  });

  it('should return Date.now() for new reason', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711036800000);
    const score = getPriorityScore('new');
    expect(score).toBe(1711036800000);
  });

  it('should return Date.now() for undefined (backwards compat)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711036800000);
    const score = getPriorityScore(undefined);
    expect(score).toBe(1711036800000);
  });

  it('should maintain ordering: resume < retry < new', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711036800000);
    const resume = getPriorityScore('resume');
    const retry = getPriorityScore('retry');
    const newScore = getPriorityScore('new');

    expect(resume).toBeLessThan(retry);
    expect(retry).toBeLessThan(newScore);
  });

  it('should preserve FIFO within same tier via timestamp', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1711036800000)
      .mockReturnValueOnce(1711036800001);

    const earlier = getPriorityScore('resume');
    const later = getPriorityScore('resume');

    expect(earlier).toBeLessThan(later);
  });
});
