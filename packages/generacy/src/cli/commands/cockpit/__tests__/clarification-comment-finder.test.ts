import { describe, it, expect, vi } from 'vitest';
import { findClarificationComment } from '../clarification-comment-finder.js';
import type { GhWrapper } from '@generacy-ai/cockpit';

function stub(overrides: Partial<GhWrapper>): GhWrapper {
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
  } as GhWrapper;
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

  it('FR-006: returns null when the only at-or-after candidate is a generacy-stage:planning status table', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-stage:planning -->\n\n<status table>',
          author: 'bot',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'planning-status',
        },
      ]),
    });
    expect(await findClarificationComment(gh, 'o/r', 1)).toBeNull();
  });

  it('FR-007: returns a generacy-stage:clarification-batch-1 comment (guards against naive startsWith)', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-stage:clarification-batch-1 -->\n\n## Clarifications\n\n### Q1: …',
          author: 'bot',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'batch-1',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('batch-1');
  });

  it('FR-008: skips a stage-status table and returns the later clarification-batch comment', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-stage:planning -->\n\n<status table>',
          author: 'bot',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'planning-status',
        },
        {
          body: '<!-- generacy-stage:clarification-batch-1 -->\n\n## Clarifications',
          author: 'bot',
          createdAt: '2026-06-25T10:02:00Z',
          url: 'batch-1',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('batch-1');
  });

  it('FR-003: mixed-body candidate with both a reject and an override marker is returned (override wins)', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-stage:planning -->\n\n<!-- generacy-stage:clarification-batch-2 -->\n\n## Clarifications',
          author: 'bot',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'mixed-body',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('mixed-body');
  });

  it('FR-002: legacy speckit-stage:implementation status table is skipped', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- speckit-stage:implementation -->\n\n<status table>',
          author: 'bot',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'speckit-impl',
        },
      ]),
    });
    expect(await findClarificationComment(gh, 'o/r', 1)).toBeNull();
  });

  it('D7: a quoted (> -prefixed) stage-status marker does not trigger the guard (column-0 rule)', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-06-25T10:00:00Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '> <!-- generacy-stage:planning -->\n\nQ1: my answer',
          author: 'human',
          createdAt: '2026-06-25T10:01:00Z',
          url: 'quoted-marker',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('quoted-marker');
  });
});
