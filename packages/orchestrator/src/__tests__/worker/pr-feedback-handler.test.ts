import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrFeedbackHandler } from '../../worker/pr-feedback-handler.js';
import { RepoCheckout } from '../../worker/repo-checkout.js';
import type { WorkerConfig } from '../../worker/config.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import type { QueueItem } from '../../types/index.js';

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeFakeProcess() {
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    pid: 42,
    kill: vi.fn(),
    exitPromise: Promise.resolve(0),
  };
}

function makeFakeLauncher() {
  const launchMock = vi.fn().mockResolvedValue({
    process: makeFakeProcess(),
    outputParser: undefined,
    metadata: { pluginId: 'test', intentKind: 'pr-feedback' },
  });
  return {
    launch: launchMock,
    registerPlugin: vi.fn(),
  } as unknown as AgentLauncher & { launch: ReturnType<typeof vi.fn> };
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp/test-workspaces',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test',
    preValidateCommand: 'pnpm install',
    maxImplementRetries: 2,
    gates: {},
    ...overrides,
  };
}

// Mock @generacy-ai/workflow-engine to avoid filesystem dependencies
vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => ({
    getPullRequest: vi.fn().mockResolvedValue({ head: { ref: 'test-branch' } }),
    getPRComments: vi.fn().mockResolvedValue([
      { id: 1, path: 'src/test.ts', line: 10, body: 'Fix this', author: 'reviewer', resolved: false },
    ]),
    getStatus: vi.fn().mockResolvedValue({ has_changes: false, staged: [], unstaged: [], untracked: [] }),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    replyToPRComment: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('PrFeedbackHandler credentials', () => {
  let launcher: ReturnType<typeof makeFakeLauncher>;
  let logger: ReturnType<typeof makeFakeLogger>;

  beforeEach(() => {
    launcher = makeFakeLauncher();
    logger = makeFakeLogger();
    vi.clearAllMocks();

    // Mock RepoCheckout.switchBranch to avoid spawning git
    vi.spyOn(RepoCheckout.prototype, 'switchBranch').mockResolvedValue();
  });

  it('should include credentials in launch request when credentialRole is set', async () => {
    const config = makeConfig({ credentialRole: 'developer' });
    const handler = new PrFeedbackHandler(config, logger, launcher);

    const item: QueueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 1,
      command: 'address-pr-feedback',
      workflowName: 'speckit-feature',
      metadata: { prNumber: 42 },
    };

    // Mock commitAndPushChanges to avoid git operations
    vi.spyOn(handler as any, 'commitAndPushChanges').mockResolvedValue(false);

    await handler.handle(item, '/tmp/checkout');

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          role: 'developer',
          uid: expect.any(Number),
          gid: expect.any(Number),
        }),
      }),
    );
  });

  it('should omit credentials in launch request when credentialRole is not set', async () => {
    const config = makeConfig();
    const handler = new PrFeedbackHandler(config, logger, launcher);

    const item: QueueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 1,
      command: 'address-pr-feedback',
      workflowName: 'speckit-feature',
      metadata: { prNumber: 42 },
    };

    vi.spyOn(handler as any, 'commitAndPushChanges').mockResolvedValue(false);

    await handler.handle(item, '/tmp/checkout');

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: undefined,
      }),
    );
  });
});
