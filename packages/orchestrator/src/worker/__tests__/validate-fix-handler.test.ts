import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidateFixHandler } from '../validate-fix-handler.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { WorkerConfig } from '../config.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import type { PhaseTracker, QueueItem } from '../../types/index.js';
import type { Logger } from '../types.js';

vi.mock('@generacy-ai/workflow-engine', async (importActual) => {
  const actual = await importActual<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...actual,
    executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    wrapUntrustedData: (s: string, _label: string) => `<untrusted>\n${s}\n</untrusted>`,
  };
});

function makeLogger(): Logger {
  const l = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  l.child.mockReturnValue(l);
  return l as unknown as Logger;
}

function makePhaseTracker(overrides: Partial<PhaseTracker> = {}): PhaseTracker {
  const impl = {
    isDuplicate: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    tryMarkProcessed: vi.fn(async () => true),
    isDuplicateRaw: vi.fn(async () => false),
    markProcessedRaw: vi.fn(async () => undefined),
    ...overrides,
  };
  return impl as unknown as PhaseTracker;
}

function makeGithub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const base = {
    getStatus: vi.fn(async () => ({
      branch: 'feat/x', has_changes: true, staged: [], unstaged: [], untracked: [],
      hasUnpushed: false, unpushedCount: 0,
    })),
    stageAll: vi.fn(async () => undefined),
    commit: vi.fn(async () => ({ sha: 'abc123', files_committed: ['src/patch.ts'] })),
    push: vi.fn(async () => ({ success: true, ref: 'feat/x', remote: 'origin' })),
    getCurrentBranch: vi.fn(async () => 'feat/x'),
    listOpenPullRequests: vi.fn(async () => []),
    prDiffNames: vi.fn(async () => []),
    addLabels: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as GitHubClient;
}

function makeLauncher(exitCode: number | null = 0): AgentLauncher {
  const launch = vi.fn(async (_req) => ({
    process: {
      stdin: null, stdout: null, stderr: null, pid: 1,
      kill: () => true,
      exitPromise: Promise.resolve(exitCode),
    },
    outputParser: { processChunk: () => undefined, flush: () => undefined },
    metadata: { pluginId: 'claude-code', intentKind: 'validate-fix' },
  }));
  return { launch } as unknown as AgentLauncher;
}

const baseConfig = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  credentialRole: 'speckit-feature',
  phaseTimeoutMs: 300_000,
  shutdownGracePeriodMs: 5000,
  workspaceDir: '/tmp/ws',
  maxImplementRetries: 2,
  ...(overrides as WorkerConfig),
}) as WorkerConfig;

const item: QueueItem = {
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 892,
  workflowName: 'speckit-feature',
  command: 'continue',
  priority: Date.now(),
  enqueuedAt: new Date().toISOString(),
};

const ctx = { prNumber: 42, baseBranch: 'develop' };
const evidence = { stdout: `Cannot find module '@/components/CopyButton'`, stderr: '', exitCode: 1 };

describe('ValidateFixHandler (#892)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('first red on hash — marks processed, launches with validate-fix intent, credentials from credentialRole', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub();
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(tracker.isDuplicate).toHaveBeenCalledWith('acme', 'widgets', 892, expect.stringMatching(/^validate-fix:[0-9a-f]{64}$/));
    expect(tracker.markProcessed).toHaveBeenCalled();
    expect((launcher.launch as any).mock.calls.length).toBe(1);
    const req = (launcher.launch as any).mock.calls[0]![0];
    expect(req.intent.kind).toBe('validate-fix');
    expect(req.intent.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(req.credentials?.role).toBe('speckit-feature');
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({ status: 'attempted' }));
  });

  it('duplicate hash — no markProcessed, no launch, escalation event emitted', async () => {
    const tracker = makePhaseTracker({ isDuplicate: vi.fn(async () => true) });
    const github = makeGithub();
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(tracker.markProcessed).not.toHaveBeenCalled();
    expect((launcher.launch as any).mock.calls.length).toBe(0);
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({
      status: 'escalated',
      reason: 'duplicate-evidence-hash',
    }));
    expect(github.addLabels).toHaveBeenCalledWith('acme', 'widgets', 892, expect.arrayContaining(['blocked:stuck-validate-fix']));
  });

  it('no-diff termination — blocked event, stuck label', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub({
      getStatus: vi.fn(async () => ({
        branch: 'feat/x', has_changes: false, staged: [], unstaged: [], untracked: [],
        hasUnpushed: false, unpushedCount: 0,
      })),
    });
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(github.push).not.toHaveBeenCalled();
    expect(github.addLabels).toHaveBeenCalledWith('acme', 'widgets', 892, ['blocked:stuck-validate-fix']);
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({
      status: 'blocked', reason: 'no-diff',
    }));
  });

  it('sibling-file overlap — reverts commit, does not push, blocked event with reason=sibling-file-overlap', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub({
      commit: vi.fn(async () => ({
        sha: 'abc', files_committed: ['src/components/CopyButton.tsx', 'src/patch.ts'],
      })),
      listOpenPullRequests: vi.fn(async () => [{
        number: 7, title: 't', body: '', state: 'open', draft: false,
        head: { ref: 'feat/7', sha: '0'.repeat(40), repo: 'acme/widgets' },
        base: { ref: 'develop', sha: '0'.repeat(40), repo: 'acme/widgets' },
        labels: [],
        created_at: '', updated_at: '',
      }]),
      prDiffNames: vi.fn(async () => ['src/components/CopyButton.tsx']),
    });
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(github.push).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({
      status: 'blocked',
      reason: 'sibling-file-overlap',
      overlappingFiles: ['src/components/CopyButton.tsx'],
    }));
  });

  it('successful attempt — push happens, attempted event emitted', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub();
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(github.push).toHaveBeenCalledWith('origin', 'feat/x');
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({
      status: 'attempted',
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('launcher.launch throws — blocked event with reason=launch-error, key stays processed', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub();
    const launcher = { launch: vi.fn(async () => { throw new Error('boom'); }) } as unknown as AgentLauncher;
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);

    expect(tracker.markProcessed).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({
      status: 'blocked', reason: 'launch-error',
    }));
    expect(github.addLabels).toHaveBeenCalledWith('acme', 'widgets', 892, ['blocked:stuck-validate-fix']);
  });

  it('sibling prDiffNames throws for one sibling — spawn proceeds, partial file list', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub({
      listOpenPullRequests: vi.fn(async () => [
        { number: 1, base: { ref: 'develop', sha: '', repo: '' }, head: { ref: '', sha: '', repo: '' }, labels: [], title: '', body: '', state: 'open', draft: false, created_at: '', updated_at: '' } as any,
        { number: 2, base: { ref: 'develop', sha: '', repo: '' }, head: { ref: '', sha: '', repo: '' }, labels: [], title: '', body: '', state: 'open', draft: false, created_at: '', updated_at: '' } as any,
      ]),
      prDiffNames: vi.fn()
        .mockRejectedValueOnce(new Error('gh fail'))
        .mockResolvedValueOnce(['other/file.ts']),
    });
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);
    // Spawn should still have happened.
    expect((launcher.launch as any).mock.calls.length).toBe(1);
    expect(emit).toHaveBeenCalledWith('cluster.validate-fix', expect.objectContaining({ status: 'attempted' }));
  });

  it('credentialRole inheritance — passes through to launcher credentials', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub();
    const launcher = makeLauncher(0);
    const handler = new ValidateFixHandler(baseConfig({ credentialRole: 'custom-role' } as WorkerConfig), launcher, tracker, logger);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);
    const req = (launcher.launch as any).mock.calls[0]![0];
    expect(req.credentials?.role).toBe('custom-role');
  });

  it('event schema — evidenceHash 64-hex, status ∈ {attempted, escalated, blocked}, ISO timestamp', async () => {
    const tracker = makePhaseTracker();
    const github = makeGithub();
    const launcher = makeLauncher(0);
    const emit = vi.fn();
    const handler = new ValidateFixHandler(baseConfig(), launcher, tracker, logger, emit);

    await handler.handle(item, '/tmp/co', ctx, evidence, github);
    const emitted = (emit.mock.calls[0]![1]) as {
      status: string; evidenceHash: string; timestamp: string;
    };
    expect(['attempted', 'escalated', 'blocked']).toContain(emitted.status);
    expect(emitted.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emitted.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });
});
