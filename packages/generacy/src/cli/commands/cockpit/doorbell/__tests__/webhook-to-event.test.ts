import { describe, expect, it } from 'vitest';
import { webhookToStreamEvent, type RefSetView } from '../webhook-to-event.js';
import type { CockpitEventValidated } from '../../watch/emit.js';

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
    expect(ev.to).toBeNull();
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
