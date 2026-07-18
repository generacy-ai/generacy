import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GhWrapper } from '@generacy-ai/cockpit';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }),
}));

// Import AFTER vi.mock so the finder picks up the mocked logger.
const { findClarificationComment } = await import('../clarification-comment-finder.js');

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
  beforeEach(() => {
    warnSpy.mockClear();
  });

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
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when no waiting-for:clarification label event in timeline', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        { event: 'labeled', label: { name: 'phase:clarify' }, created_at: '2026-06-25T10:00:00Z' },
      ]),
      fetchIssueComments: vi.fn(async () => []),
    });
    expect(await findClarificationComment(gh, 'o/r', 1)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(warnSpy).not.toHaveBeenCalled();
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
    expect(warnSpy).not.toHaveBeenCalled();
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
    expect(warnSpy).not.toHaveBeenCalled();
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('US1: returns marker-carrying comment when label re-applied after question comment (regression for #995)', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => [
        {
          event: 'labeled',
          label: { name: 'waiting-for:clarification' },
          created_at: '2026-07-18T04:31:08Z',
        },
      ]),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-clarifications:42 -->\n\n## ❓ Clarification questions — Batch 1',
          author: 'bot',
          createdAt: '2026-07-18T03:02:00Z',
          url: 'marker-comment',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 995);
    expect(c?.url).toBe('marker-comment');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('FR-002: returns latest-by-createdAt marker comment when multiple exist', async () => {
    const gh = stub({
      fetchIssueTimeline: vi.fn(async () => []),
      fetchIssueComments: vi.fn(async () => [
        {
          body: '<!-- generacy-clarifications:1 -->\n\n## Batch 1',
          author: 'bot',
          createdAt: '2026-07-10T10:00:00Z',
          url: 'batch-1',
        },
        {
          body: '<!-- generacy-clarifications:2 -->\n\n## Batch 2',
          author: 'bot',
          createdAt: '2026-07-15T10:00:00Z',
          url: 'batch-2',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'o/r', 1);
    expect(c?.url).toBe('batch-2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('FR-005: falls back to label-timeline heuristic when no marker present, emits warn', async () => {
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
          body: 'plain question comment, no marker',
          author: 'bot',
          createdAt: '2026-06-25T10:05:00Z',
          url: 'post-label',
        },
      ]),
    });
    const c = await findClarificationComment(gh, 'owner/repo', 995);
    expect(c?.url).toBe('post-label');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ owner: 'owner', repo: 'repo', issue: 995 });
    expect(message).toContain('marker-less clarification comment; poster should be updated');
    expect(message).toContain('issue=owner/repo#995');
  });
});
