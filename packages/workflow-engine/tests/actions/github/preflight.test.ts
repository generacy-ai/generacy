/**
 * Tests for github.preflight action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PreflightAction, parseGitHubIssueUrl } from '../../../src/actions/github/preflight.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { existsSync, readdirSync } from 'node:fs';

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

const mockGitHubClient = {
  getIssue: vi.fn(),
  getCurrentBranch: vi.fn(),
  branchExists: vi.fn(),
  findPRForBranch: vi.fn(),
  getPRComments: vi.fn(),
  getStatus: vi.fn(),
};

// Helper to create mock context
function createMockContext(inputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    inputs,
    outputs: {},
    env: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    signal: new AbortController().signal,
    refs: {},
  };
}

// Helper to create step definition
function createStep(inputs: Record<string, unknown> = {}): StepDefinition {
  return {
    name: 'test-step',
    uses: 'github.preflight',
    with: inputs,
  };
}

describe('parseGitHubIssueUrl', () => {
  it('parses valid GitHub issue URL', () => {
    const result = parseGitHubIssueUrl('https://github.com/owner/repo/issues/123');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 123,
    });
  });

  it('parses URL with http scheme', () => {
    const result = parseGitHubIssueUrl('http://github.com/owner/repo/issues/456');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 456,
    });
  });

  it('throws error for invalid URL', () => {
    expect(() => parseGitHubIssueUrl('not-a-url')).toThrow('Invalid GitHub issue URL');
  });

  it('throws error for non-GitHub URL', () => {
    expect(() => parseGitHubIssueUrl('https://gitlab.com/owner/repo/issues/123')).toThrow('Invalid GitHub issue URL');
  });

  it('throws error for PR URL', () => {
    expect(() => parseGitHubIssueUrl('https://github.com/owner/repo/pull/123')).toThrow('Invalid GitHub issue URL');
  });
});

describe('PreflightAction', () => {
  let action: PreflightAction;

  beforeEach(() => {
    action = new PreflightAction();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.preflight action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('handles action field as well as uses', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'github.preflight',
      };
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.commit_and_push',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      // Setup default mock responses
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        labels: [{ name: 'enhancement', color: '84b6eb' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
      mockGitHubClient.getCurrentBranch.mockResolvedValue('123-test-issue');
      mockGitHubClient.branchExists.mockResolvedValue(true);
      mockGitHubClient.findPRForBranch.mockResolvedValue(null);
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: '123-test-issue',
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['123-test-issue'] as unknown as ReturnType<typeof readdirSync>);
    });

    it('requires issue_url input', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_url'");
    });

    it('validates issue URL and returns preflight output', async () => {
      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/123',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        issue_number: 123,
        issue_title: 'Test Issue',
        issue_type: 'feature',
        on_correct_branch: true,
      });
    });

    it('detects epic issue type', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic Issue',
        body: 'Test body',
        state: 'open',
        labels: [{ name: 'type:epic', color: 'red' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/123',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect((result.output as Record<string, unknown>).issue_type).toBe('epic');
    });

    it('detects epic child from body metadata', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 456,
        title: 'Child Issue',
        body: '<!-- epic-parent: 123 -->\nChild task description',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/456',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const epicContext = output.epic_context as Record<string, unknown>;
      expect(epicContext.is_epic_child).toBe(true);
      expect(epicContext.parent_epic_number).toBe(123);
    });

    it('analyzes label status correctly', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        labels: [
          { name: 'phase:implement', color: 'green' },
          { name: 'completed:specify', color: 'green' },
          { name: 'waiting-for:spec-review', color: 'yellow' },
          { name: 'needs:spec-review', color: 'red' },
        ],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/123',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const labelStatus = output.label_status as Record<string, unknown>;
      expect(labelStatus.completed).toContain('specify');
      expect(labelStatus.waitingFor).toContain('spec-review');
      expect(labelStatus.blockedByGate).toBe(true);
    });

    it('detects uncommitted changes', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: '123-test-issue',
        has_changes: true,
        staged: ['file1.ts'],
        unstaged: ['file2.ts'],
        untracked: ['file3.ts'],
      });

      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/123',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect((result.output as Record<string, unknown>).uncommitted_changes).toBe(true);
    });

    it('handles API errors gracefully', async () => {
      mockGitHubClient.getIssue.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

      const step = createStep({
        issue_url: 'https://github.com/owner/repo/issues/123',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit');
    });
  });
});
