import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Issue } from '@generacy-ai/cockpit';
import { runOnePoll } from '../watch/poll-loop.js';
import { FakeGh, makeIssue } from './helpers/fake-gh.js';
import type { CockpitEvent } from '../watch/diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PhaseStep {
  labels: string[];
  state: 'OPEN' | 'CLOSED';
}

const fixture: PhaseStep[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'phase-walk.json'), 'utf-8'),
);

describe('SC-002 — watch emits every transition across a 10-step phase walk', () => {
  it('reproduces the phase walk as label-change + issue-closed events', async () => {
    const issuesScript: Issue[][] = fixture.map((step) => [
      makeIssue({ number: 42, labels: step.labels, state: step.state }),
    ]);
    const gh = new FakeGh({ issuesScript });
    let prev = new Map();
    const allEvents: CockpitEvent[] = [];
    for (let i = 0; i < fixture.length; i++) {
      const result = await runOnePoll(prev, {
        gh,
        refs: [{ repo: 'o/r', number: 42 }],
        epicOwnerRepo: 'o/r',
      });
      allEvents.push(...result.events);
      prev = result.curr;
    }

    expect(allEvents.length).toBeGreaterThanOrEqual(10);
    const labelChanges = allEvents.filter((e) => e.event === 'label-change');
    expect(labelChanges).toHaveLength(9);

    const states = ['pending', ...labelChanges.map((e) => e.to)];
    expect(states[0]).toBe('pending');
    expect(states).toContain('active');
    expect(states).toContain('waiting');
    expect(states).toContain('terminal');

    const closedEvent = allEvents.find((e) => e.event === 'issue-closed');
    expect(closedEvent).toBeDefined();
    expect(closedEvent?.to).toBe('terminal');
  });
});

describe('#801 — watch poll loop iterates per child repo for cross-repo epic scope', () => {
  it("polls each repo exactly once and embeds only that repo's issue numbers", async () => {
    const queries: string[] = [];
    const gh = new FakeGh({
      issuesByQuery: (query: string): Issue[] => {
        queries.push(query);
        if (query.startsWith('repo:a/b ')) {
          return [makeIssue({ number: 1, url: 'https://github.com/a/b/issues/1' })];
        }
        if (query.startsWith('repo:c/d ')) {
          return [makeIssue({ number: 2, url: 'https://github.com/c/d/issues/2' })];
        }
        return [];
      },
    });

    const result = await runOnePoll(new Map(), {
      gh,
      refs: [
        { repo: 'a/b', number: 1 },
        { repo: 'c/d', number: 2 },
      ],
      epicOwnerRepo: 'generacy-ai/tetrad-development',
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe('repo:a/b 1');
    expect(queries[1]).toBe('repo:c/d 2');

    const repos = new Set<string>();
    for (const snap of result.curr.values()) {
      repos.add(snap.repo);
    }
    expect([...repos].sort()).toEqual(['a/b', 'c/d']);
  });
});
