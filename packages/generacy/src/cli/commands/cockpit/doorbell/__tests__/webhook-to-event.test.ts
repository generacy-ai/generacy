import { describe, expect, it } from 'vitest';
import { webhookToStreamEvent, type RefSetView } from '../webhook-to-event.js';
import { buildRefSet } from '../smee-source.js';
import { snapshotKey } from '../../watch/snapshot.js';
import type { CockpitEventValidated } from '../../watch/emit.js';
import { classifyIssue } from '../../shared/classify-issue.js';

function refSetOf(): RefSetView {
  return {
    epicRef: 'o/r#100',
    epicNumber: 100,
    epicRepo: 'o/r',
    issues: new Set(['o/r#42', 'o/r#100']),
    prs: new Set(['o/r#43']),
    watchedRepos: new Set(['o/r']),
  };
}

const ts = () => '2026-07-17T00:00:00.000Z';

function repoBody(): Record<string, unknown> {
  return { repository: { name: 'r', owner: { login: 'o' } } };
}

describe('webhookToStreamEvent — Q1=A mapping table', () => {
  it('issues.labeled with issue in refSet → label-change', () => {
    const body = {
      ...repoBody(),
      issue: { number: 42, labels: [{ name: 'foo' }] },
      label: { name: 'foo' },
    };
    const result = webhookToStreamEvent('issues', 'labeled', body, refSetOf(), ts);
    expect(result).not.toBeNull();
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('label-change');
    expect(ev.kind).toBe('issue');
    expect(ev.number).toBe(42);
    expect(ev.sourceLabel).toBe('foo');
    expect(ev.from).toBeNull();
    expect(ev.to).toBe('unknown');
    expect(ev.repo).toBe('o/r');
    expect(ev.labels).toEqual(['foo']);
    expect(ev.url).toBe('https://github.com/o/r/issues/42');
  });

  it('issues.labeled with issue NOT in refSet → null', () => {
    const body = {
      ...repoBody(),
      issue: { number: 999, labels: [] },
      label: { name: 'foo' },
    };
    expect(
      webhookToStreamEvent('issues', 'labeled', body, refSetOf(), ts),
    ).toBeNull();
  });

  it('issues.unlabeled → label-change', () => {
    const body = {
      ...repoBody(),
      issue: { number: 42, labels: [] },
      label: { name: 'foo' },
    };
    const result = webhookToStreamEvent('issues', 'unlabeled', body, refSetOf(), ts);
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('label-change');
  });

  it('issues.closed → issue-closed', () => {
    const body = {
      ...repoBody(),
      issue: { number: 42, labels: [] },
    };
    const result = webhookToStreamEvent('issues', 'closed', body, refSetOf(), ts);
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('issue-closed');
    expect(ev.kind).toBe('issue');
    expect(ev.sourceLabel).toBeNull();
  });

  it('pull_request.closed merged=true → pr-merged', () => {
    const body = {
      ...repoBody(),
      pull_request: { number: 43, merged: true },
    };
    const result = webhookToStreamEvent(
      'pull_request',
      'closed',
      body,
      refSetOf(),
      ts,
    );
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('pr-merged');
    expect(ev.kind).toBe('pr');
    expect(ev.url).toBe('https://github.com/o/r/pull/43');
  });

  it('pull_request.closed merged=false → pr-closed', () => {
    const body = {
      ...repoBody(),
      pull_request: { number: 43, merged: false },
    };
    const result = webhookToStreamEvent(
      'pull_request',
      'closed',
      body,
      refSetOf(),
      ts,
    );
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('pr-closed');
  });

  it('check_run.completed with matched PR → pr-checks', () => {
    const body = {
      ...repoBody(),
      check_run: { pull_requests: [{ number: 43 }] },
    };
    const result = webhookToStreamEvent('check_run', 'completed', body, refSetOf(), ts);
    expect(result).not.toBeNull();
    const arr = Array.isArray(result) ? result : [result];
    expect(arr).toHaveLength(1);
    expect(arr[0]?.event).toBe('pr-checks');
    expect(arr[0]?.number).toBe(43);
  });

  it('check_suite.completed with matched PR → pr-checks', () => {
    const body = {
      ...repoBody(),
      check_suite: { pull_requests: [{ number: 43 }] },
    };
    const result = webhookToStreamEvent(
      'check_suite',
      'completed',
      body,
      refSetOf(),
      ts,
    );
    const arr = Array.isArray(result) ? result : [result];
    expect(arr[0]?.event).toBe('pr-checks');
  });

  it('pull_request_review.submitted → null (Q1=A)', () => {
    const body = {
      ...repoBody(),
      pull_request: { number: 43 },
      review: { state: 'approved' },
    };
    expect(
      webhookToStreamEvent('pull_request_review', 'submitted', body, refSetOf(), ts),
    ).toBeNull();
  });

  it('issue_comment.created → null', () => {
    const body = { ...repoBody(), issue: { number: 42 }, comment: {} };
    expect(
      webhookToStreamEvent('issue_comment', 'created', body, refSetOf(), ts),
    ).toBeNull();
  });

  it('push → null', () => {
    expect(webhookToStreamEvent('push', '', repoBody(), refSetOf(), ts)).toBeNull();
  });

  it('ping → null', () => {
    expect(webhookToStreamEvent('ping', '', repoBody(), refSetOf(), ts)).toBeNull();
  });

  it('repo not in watchedRepos → null (coarse pre-filter)', () => {
    const body = {
      repository: { name: 'other', owner: { login: 'x' } },
      issue: { number: 42, labels: [] },
      label: { name: 'foo' },
    };
    expect(
      webhookToStreamEvent('issues', 'labeled', body, refSetOf(), ts),
    ).toBeNull();
  });

  // #1106 Q2=B — owner/repo membership checks must be case-insensitive. Set
  // was built from operator-typed epic body (`o/r`); webhook payload carries
  // GitHub-canonical casing (`O/R`). A case-sensitive check drops every event.
  it('#1106 refSet lowercase vs. payload uppercase owner/repo → still matches', () => {
    const body = {
      repository: { name: 'R', owner: { login: 'O' } },
      issue: { number: 42, labels: [{ name: 'foo' }] },
      label: { name: 'foo' },
    };
    const result = webhookToStreamEvent('issues', 'labeled', body, refSetOf(), ts);
    expect(result).not.toBeNull();
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('label-change');
    // Payload casing is preserved in the emitted event (repo/url).
    expect(ev.repo).toBe('O/R');
    expect(ev.url).toBe('https://github.com/O/R/issues/42');
  });

  it('#1106 pull_request case mismatch — still matches', () => {
    const body = {
      repository: { name: 'R', owner: { login: 'O' } },
      pull_request: { number: 43, merged: true },
    };
    const result = webhookToStreamEvent(
      'pull_request',
      'closed',
      body,
      refSetOf(),
      ts,
    );
    expect(result).not.toBeNull();
    const ev = result as CockpitEventValidated;
    expect(ev.event).toBe('pr-merged');
  });

  it('#1106 check_run case mismatch — still matches', () => {
    const body = {
      repository: { name: 'R', owner: { login: 'O' } },
      check_run: { pull_requests: [{ number: 43 }] },
    };
    const result = webhookToStreamEvent('check_run', 'completed', body, refSetOf(), ts);
    expect(result).not.toBeNull();
    const arr = Array.isArray(result) ? result : [result];
    expect(arr).toHaveLength(1);
    expect(arr[0]?.event).toBe('pr-checks');
  });

  it('issues.opened → null (out of scope)', () => {
    const body = { ...repoBody(), issue: { number: 42, labels: [] } };
    expect(
      webhookToStreamEvent('issues', 'opened', body, refSetOf(), ts),
    ).toBeNull();
  });

  it('pull_request.synchronize → null', () => {
    const body = { ...repoBody(), pull_request: { number: 43, merged: false } };
    expect(
      webhookToStreamEvent('pull_request', 'synchronize', body, refSetOf(), ts),
    ).toBeNull();
  });
});

describe('buildEvent — FR-003 / FR-008b / INV-2: to === classifyIssue(labels).state', () => {
  const cases: Array<{ name: string; labels: string[] }> = [
    { name: 'waiting-for + process labels', labels: ['waiting-for:clarification', 'process:speckit-feature'] },
    { name: 'completed:validate label', labels: ['completed:validate'] },
    { name: 'agent:error label', labels: ['agent:error'] },
    { name: 'phase:implement label', labels: ['phase:implement'] },
    { name: 'unknown-only labels', labels: ['random-thing'] },
    { name: 'empty labels', labels: [] },
  ];

  for (const { name, labels } of cases) {
    it(`${name} — to matches classifyIssue().state, from stays null`, () => {
      const body = {
        ...repoBody(),
        issue: { number: 42, labels: labels.map((n) => ({ name: n })) },
        label: { name: labels[0] ?? 'placeholder' },
      };
      const result = webhookToStreamEvent(
        'issues',
        'labeled',
        body,
        refSetOf(),
        ts,
      );
      expect(result).not.toBeNull();
      const ev = result as CockpitEventValidated;
      const classified = classifyIssue(labels);
      expect(ev.to).toBe(classified.state);
      expect(ev.from).toBeNull();
      if (classified.sourceLabel !== '') {
        expect(ev.sourceLabel).toBe(classified.sourceLabel);
      } else {
        // fall back to the label passed by the labeled event
        expect(ev.sourceLabel).toBe(labels[0] ?? 'placeholder');
      }
    });
  }
});

// #1106 Q2=B — producer-side invariant. `buildRefSet` MUST lowercase every set
// entry it constructs so that `webhookToStreamEvent`'s query-side lookups (which
// receive GitHub-canonical casing from the webhook payload) always match, even
// when the epic body uses mixed casing (e.g., `Painworth/doc-intel`).
// Reverting the `.toLowerCase()` calls in `repoRefsToSets`/`buildRefSet`
// silently reintroduces the total smee-doorbell outage that #1106 fixes; this
// test is the mutation-testable pin.
describe('buildRefSet — #1106 producer-side normalization invariant', () => {
  it('lowercases every set entry when allRefs uses mixed/canonical casing', () => {
    const resolved = {
      epic: { repo: 'Painworth/Doc-Intel', number: 100 },
      parsed: {
        phases: [],
        adhocRefs: [],
        allRefs: [
          { repo: 'Painworth/Doc-Intel', number: 42 },
          { repo: 'Painworth/OTHER-Repo', number: 7 },
        ],
        warnings: [],
      },
      repos: ['Painworth/Doc-Intel'],
      bodyHash: 'x',
    };
    const view = buildRefSet(resolved);
    expect(view.watchedRepos).toContain('painworth/doc-intel');
    expect(view.watchedRepos).toContain('painworth/other-repo');
    expect(view.watchedRepos).not.toContain('Painworth/Doc-Intel');
    expect(view.issues).toContain('painworth/doc-intel#42');
    expect(view.issues).toContain('painworth/doc-intel#100');
    expect(view.issues).toContain('painworth/other-repo#7');
    expect(view.prs).toContain('painworth/doc-intel#42');
    expect(view.prs).toContain('painworth/other-repo#7');
    // Emitted-event fields (epicRef/epicRepo) preserve original casing.
    expect(view.epicRepo).toBe('Painworth/Doc-Intel');
    expect(view.epicRef).toBe('Painworth/Doc-Intel#100');
  });

  it('accepts a mixed-case payload against a mixed-case-built ref set', () => {
    const resolved = {
      epic: { repo: 'Painworth/Doc-Intel', number: 100 },
      parsed: {
        phases: [],
        adhocRefs: [],
        allRefs: [{ repo: 'Painworth/Doc-Intel', number: 42 }],
        warnings: [],
      },
      repos: ['Painworth/Doc-Intel'],
      bodyHash: 'x',
    };
    const view = buildRefSet(resolved);
    const body = {
      repository: { name: 'doc-intel', owner: { login: 'painworth' } },
      issue: { number: 42, labels: [] },
      label: { name: 'foo' },
    };
    const result = webhookToStreamEvent('issues', 'labeled', body, view, ts);
    expect(result).not.toBeNull();
  });
});

// #1106 Q2=B follow-up — the doorbell's PrSnapshot cache is written by
// `poll-loop.ts` using `IssueRef.repo` (operator-typed) and read by
// `smee-source.ts:375` using `ev.repo` (payload-canonical). Prior to the
// snapshot.ts fix, a case mismatch produced silent cache misses and every
// `pr-checks` / `completed:validate` event lost its `checks` field. Pin the
// normalization at the key layer so any future refactor of `snapshotKey`
// that drops it fails here.
describe('snapshotKey — #1106 case-insensitive lookup invariant', () => {
  it('produces identical keys for equivalent repos with differing casing', () => {
    expect(snapshotKey('Painworth/Doc-Intel', 'pr', 42)).toBe(
      snapshotKey('painworth/doc-intel', 'pr', 42),
    );
    expect(snapshotKey('O/R', 'issue', 100)).toBe(snapshotKey('o/r', 'issue', 100));
  });

  it('written under operator-typed casing, retrievable under payload casing', () => {
    const map = new Map<string, string>();
    map.set(snapshotKey('Painworth/Doc-Intel', 'pr', 42), 'snap');
    expect(map.get(snapshotKey('painworth/doc-intel', 'pr', 42))).toBe('snap');
  });
});
