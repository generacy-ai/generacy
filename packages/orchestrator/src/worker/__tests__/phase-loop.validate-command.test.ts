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
// #1160 T012 (US1 / SC-001 / FR-001 / FR-002)
//
// The non-bugfix validate seed now resolves through `resolveWorkflowOverrides`
// so a per-workflow `validateCommand` reaches the validate spawn instead of the
// raw cluster default. speckit-bugfix keeps `resolveTargetedValidate` narrowing
// on top of the resolved base (FR-002 preserved by construction).
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

function createDeps(runValidatePhase: ReturnType<typeof vi.fn>): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
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
      runValidatePhase,
      runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
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
  changedFiles: string[],
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
      getFilesChangedBetween: vi.fn().mockResolvedValue(changedFiles),
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

describe('PhaseLoop validate-command resolution (#1160 T012)', () => {
  let phaseLoop: PhaseLoop;
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vc-ws-'));
    await fs.writeFile(
      path.join(workspaceDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    );
    phaseLoop = new PhaseLoop(makeLogger());
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('SC-001: per-workflow validateCommand reaches the validate spawn for a feature job', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    deps.settings = {
      workflows: {
        'speckit-feature': { validateCommand: 'X' },
      },
    } as any;
    const context = createContext(workspaceDir, 'speckit-feature', ['src/index.ts'], logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    // The per-workflow override wins over the cluster default — feature workflows
    // skip the targeted-validate rewrite, so the resolved command runs verbatim.
    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'X', context.signal);
  });

  it('precedence: workflows.<name> wins over settings-level and cluster default', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    deps.settings = {
      validateCommand: 'repo-level',
      workflows: {
        'speckit-feature': { validateCommand: 'workflow-level' },
      },
    } as any;
    const context = createContext(workspaceDir, 'speckit-feature', ['src/index.ts'], logger);

    await phaseLoop.executeLoop(context, createConfig({ validateCommand: 'cluster-level' }), deps, [
      'validate',
    ]);

    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'workflow-level', context.signal);
  });

  it('precedence: settings-level wins over cluster default when no workflow entry', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    deps.settings = { validateCommand: 'repo-level' } as any;
    const context = createContext(workspaceDir, 'speckit-feature', ['src/index.ts'], logger);

    await phaseLoop.executeLoop(context, createConfig({ validateCommand: 'cluster-level' }), deps, [
      'validate',
    ]);

    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'repo-level', context.signal);
  });

  it('precedence: cluster default used when neither workflow nor settings tier is set', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(workspaceDir, 'speckit-feature', ['src/index.ts'], logger);

    await phaseLoop.executeLoop(context, createConfig({ validateCommand: 'cluster-level' }), deps, [
      'validate',
    ]);

    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'cluster-level', context.signal);
  });

  it('FR-002: speckit-bugfix applies resolveTargetedValidate narrowing over the resolved base', async () => {
    const logger = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // A per-workflow override supplies the base; the built-in default classification
    // still narrows it to the touched-package filter for a bugfix job.
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['packages/a/src/x.ts'],
      logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    // Built-in default → targeted narrowing composes on top of the resolved base.
    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test',
      context.signal,
    );
  });
});
