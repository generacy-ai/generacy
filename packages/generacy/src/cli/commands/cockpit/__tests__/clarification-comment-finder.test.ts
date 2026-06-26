import { describe, it, expect, vi } from 'vitest';
import { findClarificationComment } from '../clarification-comment-finder.js';
import type { CockpitGh } from '../gh-ext.js';

function stub(overrides: Partial<CockpitGh>): CockpitGh {
  return {
    fetchIssueLabels: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as CockpitGh;
}

describe('findClarificationComment', () => {
  it('returns the first comment created at-or-after the latest waiting-for:clarification label event', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        { event: 'labeled', label: { name: 'phase:clarify' }, created_at: '2026-06-20T10:00:00Z' },
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        { body: 'before', author: 'bot', createdAt: '2026-06-20T11:00:00Z', url: 'a' },
        { body: 'qualifying', author: 'bot', createdAt: '2026-06-25T11:00:00Z', url: 'b' },
        { body: 'later', author: 'bot', createdAt: '2026-06-26T11:00:00Z', url: 'c' },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('b');
  });

  it('returns null when no qualifying comment exists', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        { body: 'before', author: 'bot', createdAt: '2026-06-24T11:00:00Z', url: 'a' },
      ]),
    });
    expect(await findClarificationComment(gh, 'o/r', 1)).toBeNull();
  });

  it('returns null when no waiting-for:clarification label event in timeline', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        { event: 'labeled', label: { name: 'phase:clarify' }, created_at: '2026-06-25T10:00:00Z' },
      ]),
      fetchIssueComments: vi.fn(async () => []),
    });
    expect(await findClarificationComment(gh, 'o/r', 1)).toBeNull();
  });

  it('uses the MOST RECENT waiting-for:clarification event (re-labelings)', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-01T10:00:00Z',
        },
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        { body: 'old', author: 'bot', createdAt: '2026-06-02T11:00:00Z', url: 'old' },
        { body: 'new', author: 'bot', createdAt: '2026-06-26T11:00:00Z', url: 'new' },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('new');
  });
});
