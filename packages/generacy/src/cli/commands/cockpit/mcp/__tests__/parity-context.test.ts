import { describe, it, expect, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { runContext } from '../../context.js';
import { cockpitContext } from '../tools/cockpit_context.js';

function stubGh(): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:spec-review'] })),
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
      labels: ['waiting-for:spec-review'],
      url: 'https://github.com/generacy-ai/generacy/issues/917',
    } as Issue)),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    resolveIssueToPR: vi.fn(),
    getPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    getRequiredCheckNames: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addAssignees: vi.fn(),
    getCurrentUser: vi.fn(),
    deleteHeadRef: vi.fn(),
  } as unknown as GhWrapper;
}

describe('cockpit_context parity', () => {
  it('MCP tool result data deep-equals runContext return value', async () => {
    const cliBundle = await runContext('generacy-ai/generacy#917', {
      gh: stubGh(),
      stdout: () => undefined,
      getBranch: async () => '',
      cwd: '/tmp/nowhere-parity-context',
    });

    const mcpResult = await cockpitContext(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh: stubGh() },
    );
    expect(mcpResult.status).toBe('ok');
    if (mcpResult.status !== 'ok') return;
    expect(mcpResult.data).toEqual(cliBundle);
  });
});
