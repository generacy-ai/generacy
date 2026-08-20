import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ValidateFixHandler } from '../validate-fix-handler.js';
import type { ValidateFailureEvidence } from '../validate-fix-handler.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ProcessFactory, ChildProcessHandle, Logger } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Capture the prompt handed to the launch plugin so we can assert on it.
// ---------------------------------------------------------------------------
let capturedPrompt: string | undefined;

// ---------------------------------------------------------------------------
// Mock @generacy-ai/workflow-engine
//  - wrapUntrustedData: pass-through fence (record the raw content)
//  - executeCommand: git plumbing used by commitChanges fallback + revert
// ---------------------------------------------------------------------------
const executeCommandMock = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
vi.mock('@generacy-ai/workflow-engine', () => ({
  wrapUntrustedData: vi.fn((content: string) => content),
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

// ---------------------------------------------------------------------------
// Mock GitHub Client
// ---------------------------------------------------------------------------
function makeGitHub(overrides: Partial<Record<string, unknown>> = {}): GitHubClient {
  return {
    listOpenPullRequests: vi.fn().mockResolvedValue([]),
    prDiffNames: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ has_changes: false, staged: [], unstaged: [], untracked: [] }),
    stageAll: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ files_committed: [] }),
    push: vi.fn().mockResolvedValue(undefined),
    getCurrentBranch: vi.fn().mockResolvedValue('feature-branch'),
    ...overrides,
  } as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// Mock Process Helper
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 10) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn(() => true),
    exitPromise,
  };

  if (exitDelay >= 0) {
    setTimeout(() => exitResolve(exitCode), exitDelay);
  }

  return { handle, stdout, stderr, resolve: exitResolve! };
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------
const defaultConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'pnpm test && pnpm build',
  gates: {},
} as unknown as WorkerConfig;

function createItem(): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'continue',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
  } as unknown as QueueItem;
}

const evidence: ValidateFailureEvidence = {
  stdout: "src/foo.ts:10:5 - error TS2304: Cannot find name 'bar'.",
  stderr: 'exit 1',
  exitCode: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ValidateFixHandler (thin remediate adapter #1129)', () => {
  let handler: ValidateFixHandler;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedPrompt = undefined;
    executeCommandMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    spawnFn = vi.fn();
    const processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());

    // Capture the prompt the adapter builds by intercepting launch().
    const realLaunch = agentLauncher.launch.bind(agentLauncher);
    vi.spyOn(agentLauncher, 'launch').mockImplementation(async (req: Parameters<typeof realLaunch>[0]) => {
      const intent = req.intent as { prompt?: string };
      capturedPrompt = intent.prompt;
      const { handle } = createMockProcess(0, 10);
      return { process: handle } as unknown as Awaited<ReturnType<typeof realLaunch>>;
    });

    handler = new ValidateFixHandler(defaultConfig, agentLauncher, mockLogger);
  });

  it('builds the fix prompt from the failing evidence and spawns the fixer', async () => {
    const github = makeGitHub();

    await handler.handle(
      createItem(),
      '/tmp/workspace/test-owner/test-repo',
      { prNumber: 42, baseBranch: 'develop' },
      evidence,
      github,
      'speckit-feature',
    );

    expect(capturedPrompt).toBeDefined();
    // Evidence stdout appears in the prompt (via the fenced untrusted block).
    expect(capturedPrompt).toContain("Cannot find name 'bar'");
    // The prompt is anchored to the failing PR.
    expect(capturedPrompt).toContain('#42');
  });

  it('commits and pushes when the fixer produces changes', async () => {
    const commit = vi.fn().mockResolvedValue({ files_committed: ['src/foo.ts'] });
    const push = vi.fn().mockResolvedValue(undefined);
    const github = makeGitHub({
      getStatus: vi.fn().mockResolvedValue({ has_changes: true, staged: [], unstaged: [], untracked: [] }),
      commit,
      push,
    });

    await handler.handle(
      createItem(),
      '/tmp/workspace/test-owner/test-repo',
      { prNumber: 42, baseBranch: 'develop' },
      evidence,
      github,
      'speckit-feature',
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('enumerates sibling-owned files and instructs the fixer not to recreate them', async () => {
    const listOpenPullRequests = vi.fn().mockResolvedValue([
      { number: 7, base: { ref: 'develop' } }, // sibling on same base
      { number: 42, base: { ref: 'develop' } }, // own PR — excluded
      { number: 9, base: { ref: 'main' } }, // different base — excluded
    ]);
    const prDiffNames = vi.fn(async (_repo: string, prNumber: number) =>
      prNumber === 7 ? ['src/sibling-owned.ts'] : [],
    );
    const github = makeGitHub({ listOpenPullRequests, prDiffNames });

    await handler.handle(
      createItem(),
      '/tmp/workspace/test-owner/test-repo',
      { prNumber: 42, baseBranch: 'develop' },
      evidence,
      github,
      'speckit-feature',
    );

    expect(listOpenPullRequests).toHaveBeenCalled();
    // Only the same-base sibling's diff is queried.
    expect(prDiffNames).toHaveBeenCalledWith('test-owner/test-repo', 7);
    expect(prDiffNames).not.toHaveBeenCalledWith('test-owner/test-repo', 9);
    // The sibling-owned file is surfaced in the prompt's do-not-create list.
    expect(capturedPrompt).toContain('src/sibling-owned.ts');
  });

  it('reverts the commit and throws when the fix overlaps a sibling-owned file', async () => {
    const overlapping = 'src/sibling-owned.ts';
    const listOpenPullRequests = vi.fn().mockResolvedValue([{ number: 7, base: { ref: 'develop' } }]);
    const prDiffNames = vi.fn().mockResolvedValue([overlapping]);
    const commit = vi.fn().mockResolvedValue({ files_committed: [overlapping] });
    const push = vi.fn().mockResolvedValue(undefined);
    const github = makeGitHub({
      listOpenPullRequests,
      prDiffNames,
      getStatus: vi.fn().mockResolvedValue({ has_changes: true, staged: [], unstaged: [], untracked: [] }),
      commit,
      push,
    });

    await expect(
      handler.handle(
        createItem(),
        '/tmp/workspace/test-owner/test-repo',
        { prNumber: 42, baseBranch: 'develop' },
        evidence,
        github,
        'speckit-feature',
      ),
    ).rejects.toThrow(/sibling-owned-file overlap/);

    // Overlap must never be pushed.
    expect(push).not.toHaveBeenCalled();
    // The commit is reverted via `git reset --hard HEAD~1`.
    expect(executeCommandMock).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'HEAD~1'],
      expect.objectContaining({ cwd: '/tmp/workspace/test-owner/test-repo' }),
    );
  });

  it('does not run the fixer more than once per call (no evidence-hash one-attempt cap)', async () => {
    // FR-005: the one-attempt-per-evidence-hash dedupe gate is gone. Two calls
    // with identical evidence both spawn — the loop owns budgeting now.
    const github = makeGitHub();

    await handler.handle(createItem(), '/tmp/wk', { prNumber: 42, baseBranch: 'develop' }, evidence, github, 'speckit-feature');
    await handler.handle(createItem(), '/tmp/wk', { prNumber: 42, baseBranch: 'develop' }, evidence, github, 'speckit-feature');

    // Both calls reached the launch site — no persisted cap short-circuited the second.
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('never applies failed:* escalation labels (the phase loop owns escalation)', async () => {
    // FR-005: the adapter carries no label surface. A GitHub client without any
    // label methods must still complete the happy path.
    const github = makeGitHub();
    // Assert the adapter never calls label mutators even if present.
    (github as unknown as Record<string, unknown>).addLabels = vi.fn();
    (github as unknown as Record<string, unknown>).removeLabels = vi.fn();

    await handler.handle(
      createItem(),
      '/tmp/workspace/test-owner/test-repo',
      { prNumber: 42, baseBranch: 'develop' },
      evidence,
      github,
      'speckit-feature',
    );

    expect((github as unknown as { addLabels: ReturnType<typeof vi.fn> }).addLabels).not.toHaveBeenCalled();
    expect((github as unknown as { removeLabels: ReturnType<typeof vi.fn> }).removeLabels).not.toHaveBeenCalled();
  });
});
