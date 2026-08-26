import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { DEFAULT_VALIDATE_COMMAND } from '../config.js';

// ---------------------------------------------------------------------------
// #1160 T013 (US2 / SC-002 / FR-003 / FR-004)
//
// The pre-validate install step now resolves `preValidateCommand` per-workflow.
// `??` in the resolver preserves an explicit `""` (skip) vs unset (fall-through),
// and the existing `if (cmd)` truthiness guard skips the install on empty-string.
// ---------------------------------------------------------------------------

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

function makeLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

function createDeps(runPreValidateInstall: ReturnType<typeof vi.fn>): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn().mockReturnValue([]),
    } as any,
    cliSpawner: {
      spawnPhase: vi.fn().mockResolvedValue(makeSuccessResult('implement')),
      runValidatePhase: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
      runPreValidateInstall,
    } as any,
    outputCapture: {
      processChunk: vi.fn(),
      flush: vi.fn(),
      getOutput: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as any,
    prManager: {
      commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
      getPrNumber: vi.fn().mockReturnValue(undefined),
    } as any,
  };
}

function createContext(
  checkoutPath: string,
  workflowName: string,
  logger: Logger,
): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1160,
      workflowName,
    } as any,
    startPhase: 'validate',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['src/index.ts']),
    } as any,
    logger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: 'https://github.com/test/repo/issues/1160',
    description: 'test',
  };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: DEFAULT_VALIDATE_COMMAND,
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 0,
    ...overrides,
  } as WorkerConfig;
}

describe('PhaseLoop preValidate-command resolution (#1160 T013)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutDir: string;

  beforeEach(async () => {
    checkoutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pvc-'));
    phaseLoop = new PhaseLoop(makeLogger());
  });

  afterEach(async () => {
    await fs.rm(checkoutDir, { recursive: true, force: true });
  });

  it('SC-002: per-workflow preValidateCommand runs at the install step', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runPreValidateInstall = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runPreValidateInstall);
    deps.settings = {
      workflows: {
        'speckit-feature': { preValidateCommand: 'Y' },
      },
    } as any;
    const context = createContext(checkoutDir, 'speckit-feature', logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runPreValidateInstall).toHaveBeenCalledWith(checkoutDir, 'Y', context.signal);
  });

  it('explicit "" at the workflow tier skips the install step (not fall-through)', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runPreValidateInstall = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runPreValidateInstall);
    // Cluster default would install, but the workflow tier explicitly opts out.
    deps.settings = {
      workflows: {
        'speckit-feature': { preValidateCommand: '' },
      },
    } as any;
    const context = createContext(checkoutDir, 'speckit-feature', logger);

    await phaseLoop.executeLoop(
      context,
      createConfig({ preValidateCommand: 'pnpm install' }),
      deps,
      ['validate'],
    );

    expect(runPreValidateInstall).not.toHaveBeenCalled();
  });

  it('unset workflow tier falls through to the repo/cluster preValidateCommand', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runPreValidateInstall = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runPreValidateInstall);
    deps.settings = { preValidateCommand: 'npm ci' } as any;
    const context = createContext(checkoutDir, 'speckit-feature', logger);

    await phaseLoop.executeLoop(
      context,
      createConfig({ preValidateCommand: 'pnpm install' }),
      deps,
      ['validate'],
    );

    expect(runPreValidateInstall).toHaveBeenCalledWith(checkoutDir, 'npm ci', context.signal);
  });

  it('no tier set → cluster default install command runs', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runPreValidateInstall = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runPreValidateInstall);
    const context = createContext(checkoutDir, 'speckit-feature', logger);

    await phaseLoop.executeLoop(
      context,
      createConfig({ preValidateCommand: 'pnpm install' }),
      deps,
      ['validate'],
    );

    expect(runPreValidateInstall).toHaveBeenCalledWith(checkoutDir, 'pnpm install', context.signal);
  });
});
