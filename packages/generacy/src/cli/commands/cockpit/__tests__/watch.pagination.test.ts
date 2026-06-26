import { describe, expect, it } from 'vitest';
import type { Issue, ListIssuesOptions } from '@generacy-ai/cockpit';
import { listAllIssues } from '../shared/pagination.js';
import { FakeGh, makeIssue } from './helpers/fake-gh.js';

function makeIssues(start: number, count: number): Issue[] {
  return Array.from({ length: count }, (_, i) => makeIssue({ number: start + i }));
}

describe('listAllIssues', () => {
  it('paginates until a page returns fewer items than requested', async () => {
    const pages: Issue[][] = [
      makeIssues(1, 100),
      makeIssues(101, 100),
      makeIssues(201, 47),
    ];
    let cursor = 0;
    const gh = new FakeGh({
      issuesByQuery: () => {
        const out = pages[cursor] ?? [];
        cursor += 1;
        return out;
      },
    });
    const result = await listAllIssues(gh, 'repo:o/r is:open');
    expect(result).toHaveLength(247);
    const listCalls = gh.calls.filter((c) => c.method === 'listIssues');
    expect(listCalls).toHaveLength(3);
  });

  it('stops cursoring when no createdAt is available', async () => {
    const gh = new FakeGh({
      issuesByQuery: () =>
        Array.from({ length: 100 }, (_, i) => ({
          ...makeIssue({ number: i + 1 }),
          createdAt: '',
        })),
    });
    const result = await listAllIssues(gh, 'q');
    expect(result.length).toBeGreaterThan(0);
  });

  it('emits one stderr warning when cumulative results exceed safetyCap', async () => {
    const warnings: string[] = [];
    const pages: Issue[][] = [makeIssues(1, 100), makeIssues(101, 50)];
    let cursor = 0;
    const gh = new FakeGh({
      issuesByQuery: () => {
        const out = pages[cursor] ?? [];
        cursor += 1;
        return out;
      },
    });
    const result = await listAllIssues(gh, 'q', {
      safetyCap: 50,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(result.length).toBeGreaterThan(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/exceeded 50 items/);
  });

  it('does not truncate when over safetyCap (warn-but-continue)', async () => {
    let calls = 0;
    const gh = new FakeGh({
      issuesByQuery: (query: string, _options?: ListIssuesOptions) => {
        calls += 1;
        if (calls === 1) return makeIssues(1, 100);
        if (calls === 2 && query.includes('created:<')) return makeIssues(101, 50);
        return [];
      },
    });
    const result = await listAllIssues(gh, 'q', {
      safetyCap: 10,
      logger: { warn: () => {} },
    });
    expect(result.length).toBe(150);
  });
});
