/**
 * Tests for sibling-fanout handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cli-utils before importing handler
vi.mock('../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { siblingFanoutHandler, type SiblingFanoutContext } from '../../src/handlers/sibling-fanout.js';
import { executeCommand } from '../../src/actions/cli-utils.js';
import type { WorkflowState, WorkflowStore } from '../../src/types/store.js';

const mockExecuteCommand = vi.mocked(executeCommand);

function success(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' };
}

function mockWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    version: '1.0',
    workflowId: 'wf-1',
    workflowFile: 'test.yaml',
    currentPhase: 'implement',
    currentStep: 'step-1',
    inputs: {},
    stepOutputs: {},
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockStore(): WorkflowStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    listPending: vi.fn().mockResolvedValue([]),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createContext(overrides: Partial<SiblingFanoutContext> = {}): SiblingFanoutContext {
  return {
    primaryWorkdir: '/workspaces/primary',
    siblingWorkdirs: {},
    issueNumber: 42,
    primaryRepoName: 'generacy',
    org: 'generacy-ai',
    workflowStore: mockStore(),
    workflowState: mockWorkflowState(),
    logger: mockLogger(),
    ...overrides,
  };
}

/**
 * Set up executeCommand mock to handle the full flow for a sibling:
 * - Primary getStatus (branch + porcelain + rev-list)
 * - Primary PR lookup (gh pr list)
 * - Primary last commit message (git log)
 * - Sibling getStatus (branch + porcelain + rev-list)
 * - Sibling branchExists remote (ls-remote)
 * - Sibling getDefaultBranch (gh repo view)
 * - Sibling createBranch (checkout -b)
 * - Sibling getStatus after checkout
 * - Sibling stageAll
 * - Sibling commit
 * - Sibling push
 * - Sibling findPRForBranch (gh pr list)
 * - Sibling getDefaultBranch for PR create
 * - Sibling createPullRequest (gh pr create)
 */
function setupFullFlowMocks(opts: {
  siblingDirty?: boolean;
  siblingBranch?: string;
  remoteBranchExists?: boolean;
  prExists?: boolean;
} = {}) {
  const {
    siblingDirty = true,
    siblingBranch = 'main',
    remoteBranchExists = false,
    prExists = false,
  } = opts;

  let callIndex = 0;
  mockExecuteCommand.mockImplementation(async (cmd, args) => {
    const argsStr = (args as string[]).join(' ');
    callIndex++;

    // git branch --show-current (primary or sibling)
    if (cmd === 'git' && argsStr === 'branch --show-current') {
      // First two calls for sibling detection + primary context
      if (callIndex <= 2) return success(`${siblingBranch}\n`);
      return success('feature-branch\n');
    }

    // git status --porcelain
    if (cmd === 'git' && argsStr === 'status --porcelain') {
      if (siblingDirty && callIndex <= 3) return success(' M file.ts\n');
      return success('');
    }

    // git rev-list --count
    if (cmd === 'git' && argsStr.includes('rev-list --count')) {
      return success('0\n');
    }

    // git log -1 --format=%s (primary commit message)
    if (cmd === 'git' && argsStr.includes('log -1 --format=%s')) {
      return success('feat: add feature\n');
    }

    // git ls-remote --heads (sibling remote branch check)
    if (cmd === 'git' && argsStr.includes('ls-remote --heads')) {
      if (remoteBranchExists) return success(`abc123\trefs/heads/feature-branch\n`);
      return success('');
    }

    // git fetch
    if (cmd === 'git' && argsStr.startsWith('fetch')) {
      return success('');
    }

    // git checkout
    if (cmd === 'git' && argsStr.startsWith('checkout')) {
      return success('');
    }

    // git branch --list
    if (cmd === 'git' && argsStr.includes('branch --list')) {
      return success('');
    }

    // git add -A (stageAll)
    if (cmd === 'git' && argsStr.includes('add')) {
      return success('');
    }

    // git commit
    if (cmd === 'git' && argsStr.startsWith('commit')) {
      return success('');
    }

    // git push
    if (cmd === 'git' && argsStr.startsWith('push')) {
      return success('');
    }

    // gh repo view (getDefaultBranch)
    if (cmd === 'gh' && argsStr.includes('repo view')) {
      return success(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
    }

    // gh pr list (findPRForBranch / primary PR title)
    if (cmd === 'gh' && argsStr.includes('pr list')) {
      if (prExists) {
        return success(JSON.stringify([{
          number: 99,
          title: 'Existing PR',
          body: '',
          state: 'OPEN',
          isDraft: true,
          headRefName: 'feature-branch',
          baseRefName: 'main',
          labels: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }]));
      }
      return success('[]');
    }

    // gh pr create
    if (cmd === 'gh' && argsStr.includes('pr create')) {
      return success(JSON.stringify({
        number: 101,
        title: 'New PR',
        body: '',
        state: 'OPEN',
        isDraft: true,
        headRefName: 'feature-branch',
        baseRefName: 'main',
        labels: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }));
    }

    return success('');
  });
}

describe('siblingFanoutHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // T009: Single sibling with changes produces branch + commit + push + draft PR + linkedPR
  describe('single sibling with changes', () => {
    it('creates branch, commits, pushes, and creates draft PR', async () => {
      const store = mockStore();
      const ctx = createContext({
        siblingWorkdirs: { 'sibling-repo': '/workspaces/sibling-repo' },
        workflowStore: store,
      });

      setupFullFlowMocks({ siblingDirty: true });

      const result = await siblingFanoutHandler(ctx);

      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]!.repo).toBe('sibling-repo');
      expect(result.processed[0]!.prCreated).toBe(true);
      expect(result.skipped).toHaveLength(0);

      // Verify state was persisted with linkedPR
      expect(store.save).toHaveBeenCalled();
      const savedState = (store.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as WorkflowState;
      expect(savedState.linkedPRs).toHaveLength(1);
      expect(savedState.linkedPRs![0]!.repo).toBe('sibling-repo');
    });
  });

  // T010: Idempotency — re-running when sibling branch and PR already exist
  describe('idempotency', () => {
    it('reuses existing branch and skips PR creation when PR exists', async () => {
      const store = mockStore();
      const ctx = createContext({
        siblingWorkdirs: { 'sibling-repo': '/workspaces/sibling-repo' },
        workflowStore: store,
        workflowState: mockWorkflowState({
          linkedPRs: [{ repo: 'sibling-repo', number: 99, branch: 'feature-branch', url: 'https://github.com/generacy-ai/sibling-repo/pull/99' }],
        }),
      });

      setupFullFlowMocks({ siblingDirty: true, remoteBranchExists: true, prExists: true });

      const result = await siblingFanoutHandler(ctx);

      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]!.prCreated).toBe(false);
      expect(result.processed[0]!.prNumber).toBe(99);
    });
  });

  // T011: Short-circuit — empty siblingWorkdirs or all clean
  describe('short-circuit', () => {
    it('returns immediately when siblingWorkdirs is empty', async () => {
      const ctx = createContext({ siblingWorkdirs: {} });

      const result = await siblingFanoutHandler(ctx);

      expect(result.processed).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('returns immediately when all siblings are clean', async () => {
      const ctx = createContext({
        siblingWorkdirs: { 'clean-repo': '/workspaces/clean-repo' },
      });

      // Sibling getStatus returns clean
      mockExecuteCommand
        .mockResolvedValueOnce(success('main\n'))    // branch --show-current
        .mockResolvedValueOnce(success(''))          // status --porcelain (no changes)
        .mockResolvedValueOnce(success('0\n'));      // rev-list (no unpushed)

      const result = await siblingFanoutHandler(ctx);

      expect(result.processed).toHaveLength(0);
      expect(result.skipped).toContain('clean-repo');
    });
  });

  // T012: Error propagation
  describe('error propagation', () => {
    it('throws when push fails', async () => {
      const ctx = createContext({
        siblingWorkdirs: { 'sibling-repo': '/workspaces/sibling-repo' },
      });

      let callCount = 0;
      mockExecuteCommand.mockImplementation(async (cmd, args) => {
        callCount++;
        const argsStr = (args as string[]).join(' ');

        if (cmd === 'git' && argsStr === 'branch --show-current') return success('feature-branch\n');
        if (cmd === 'git' && argsStr === 'status --porcelain') {
          if (callCount <= 3) return success(' M file.ts\n');
          return success('');
        }
        if (cmd === 'git' && argsStr.includes('rev-list --count')) return success('0\n');
        if (cmd === 'git' && argsStr.includes('log -1 --format=%s')) return success('feat: stuff\n');
        if (cmd === 'git' && argsStr.includes('ls-remote')) return success('');
        if (cmd === 'git' && argsStr.includes('branch --list')) return success('');
        if (cmd === 'gh' && argsStr.includes('repo view')) return success(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
        if (cmd === 'git' && argsStr.startsWith('checkout')) return success('');
        if (cmd === 'git' && argsStr.includes('add')) return success('');
        if (cmd === 'git' && argsStr.startsWith('commit')) return success('');
        if (cmd === 'gh' && argsStr.includes('pr list')) return success('[]');

        // Push fails
        if (cmd === 'git' && argsStr.startsWith('push')) {
          return { exitCode: 1, stdout: '', stderr: 'Permission denied' };
        }

        return success('');
      });

      await expect(siblingFanoutHandler(ctx)).rejects.toThrow();
    });

    it('logs warning and skips sibling when detection fails', async () => {
      const logger = mockLogger();
      const ctx = createContext({
        siblingWorkdirs: { 'bad-repo': '/workspaces/bad-repo' },
        logger,
      });

      // Detection throws
      mockExecuteCommand.mockRejectedValueOnce(new Error('not a git repo'));

      const result = await siblingFanoutHandler(ctx);

      expect(result.skipped).toContain('bad-repo');
      expect(result.processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to detect changes in bad-repo'),
      );
    });
  });

  // T013: Partial failure recovery
  describe('partial failure recovery', () => {
    it('already-processed siblings are not re-processed on retry', async () => {
      const store = mockStore();
      // Simulate retry: first sibling already has a PR from previous run
      const ctx = createContext({
        siblingWorkdirs: {
          'already-done': '/workspaces/already-done',
          'needs-work': '/workspaces/needs-work',
        },
        workflowStore: store,
        workflowState: mockWorkflowState({
          linkedPRs: [{ repo: 'already-done', number: 50, branch: 'feature-branch', url: 'https://github.com/generacy-ai/already-done/pull/50' }],
        }),
      });

      let workdirContext = '';
      mockExecuteCommand.mockImplementation(async (cmd, args, opts) => {
        const argsStr = (args as string[]).join(' ');
        const cwd = (opts as { cwd?: string })?.cwd ?? '';

        if (cmd === 'git' && argsStr === 'branch --show-current') {
          workdirContext = cwd;
          return success('feature-branch\n');
        }
        if (cmd === 'git' && argsStr === 'status --porcelain') {
          // Both siblings have changes
          return success(' M file.ts\n');
        }
        if (cmd === 'git' && argsStr.includes('rev-list --count')) return success('0\n');
        if (cmd === 'git' && argsStr.includes('log -1 --format=%s')) return success('feat: stuff\n');
        if (cmd === 'git' && argsStr.includes('ls-remote')) return success(`abc\trefs/heads/feature-branch\n`);
        if (cmd === 'git' && argsStr.startsWith('fetch')) return success('');
        if (cmd === 'git' && argsStr.startsWith('checkout')) return success('');
        if (cmd === 'git' && argsStr.includes('add')) return success('');
        if (cmd === 'git' && argsStr.startsWith('commit')) return success('');
        if (cmd === 'git' && argsStr.startsWith('push')) return success('');
        if (cmd === 'gh' && argsStr.includes('repo view')) return success(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
        if (cmd === 'gh' && argsStr.includes('pr list')) {
          // already-done has a PR, needs-work does not
          if (cwd.includes('already-done')) {
            return success(JSON.stringify([{
              number: 50, title: 'Done PR', body: '', state: 'OPEN',
              isDraft: true, headRefName: 'feature-branch', baseRefName: 'main',
              labels: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            }]));
          }
          return success('[]');
        }
        if (cmd === 'gh' && argsStr.includes('pr create')) {
          return success(JSON.stringify({
            number: 102, title: 'New PR', body: '', state: 'OPEN',
            isDraft: true, headRefName: 'feature-branch', baseRefName: 'main',
            labels: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          }));
        }
        return success('');
      });

      const result = await siblingFanoutHandler(ctx);

      // Both processed (idempotent), but already-done reuses PR
      expect(result.processed).toHaveLength(2);
      const alreadyDone = result.processed.find(p => p.repo === 'already-done');
      const needsWork = result.processed.find(p => p.repo === 'needs-work');
      expect(alreadyDone!.prCreated).toBe(false);
      expect(needsWork!.prCreated).toBe(true);
    });
  });
});
