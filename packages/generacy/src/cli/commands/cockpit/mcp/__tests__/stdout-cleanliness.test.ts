/**
 * T031 — stdout-cleanliness invariant.
 *
 * Any direct `process.stdout.write` call inside a tool handler corrupts the
 * MCP JSON-RPC channel. Each handler runs under a `process.stdout.write` spy
 * that asserts zero direct calls — all `run<Verb>()`-emitted stdout must be
 * routed to the per-call sink.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { cockpitStatus } from '../tools/cockpit_status.js';
import { cockpitContext } from '../tools/cockpit_context.js';
import { cockpitAdvance } from '../tools/cockpit_advance.js';
import { cockpitResume } from '../tools/cockpit_resume.js';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';

const stubLoadConfig = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification'] })),
    fetchIssueTimeline: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => []),
    findOpenPrForBranch: vi.fn(async () => null),
    prDiffNames: vi.fn(async () => []),
    prDiffPatch: vi.fn(async () => ''),
    resolveIssueToPRRef: vi.fn(async () => ({ kind: 'unresolved' })),
    getPullRequestDetail: vi.fn(),
    getPullRequestCheckRuns: vi.fn(async () => []),
    listIssues: vi.fn(),
    getIssue: vi.fn(async () => ({
      number: 917,
      title: 'x',
      state: 'OPEN',
      labels: ['waiting-for:clarification'],
      url: 'https://github.com/generacy-ai/generacy/issues/917',
    } as Issue)),
    addLabels: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
    addLabel: vi.fn(async () => undefined),
    removeLabel: vi.fn(async () => undefined),
    resolveIssueToPR: vi.fn(),
    getPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    getRequiredCheckNames: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(async () => ({ url: 'x' })),
    addAssignees: vi.fn(),
    getCurrentUser: vi.fn(async () => 'octocat'),
    ...overrides,
  } as unknown as GhWrapper;
}

let stdoutSpy: ReturnType<typeof vi.spyOn> | null = null;

function installStdoutSpy(): ReturnType<typeof vi.spyOn> {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(
    (() => true) as unknown as typeof process.stdout.write,
  );
  return stdoutSpy;
}

afterEach(() => {
  stdoutSpy?.mockRestore();
  stdoutSpy = null;
});

describe('T031 — stdout cleanliness (no direct process.stdout.write from tool handlers)', () => {
  it('cockpit_status', async () => {
    const spy = installStdoutSpy();
    const body = '### s\n- [ ] owner/repo#1';
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: () => [makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' })],
    });
    await cockpitStatus(
      { epic: { owner: 'owner', repo: 'epic', number: 42 } },
      { gh },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('cockpit_context', async () => {
    const spy = installStdoutSpy();
    await cockpitContext(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh: stubGh() },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('cockpit_advance', async () => {
    const spy = installStdoutSpy();
    await cockpitAdvance(
      {
        issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        gate: 'clarification',
      },
      { gh: stubGh(), loadConfig: stubLoadConfig as never },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('cockpit_resume', async () => {
    const spy = installStdoutSpy();
    await cockpitResume(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      {
        gh: stubGh({
          fetchIssueLabels: vi.fn(async () => ({ labels: ['failed:implement'] })),
        }),
        loadConfig: stubLoadConfig as never,
      },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
