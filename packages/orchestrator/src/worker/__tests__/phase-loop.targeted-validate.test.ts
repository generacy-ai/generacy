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
// #1134 T007 (US2 / SC-003 / SC-005)
//
// Drives executeLoop through the validate phase and asserts the effective
// validate command the classifier resolves for speckit-bugfix, plus the single
// structured `targeted-validate` log line. Every non-bugfix workflow reaches the
// plain default unchanged (SC-005 byte-identity).
// ---------------------------------------------------------------------------

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

interface LoggerHandles {
  logger: Logger;
  info: ReturnType<typeof vi.fn>;
}

function makeLogger(): LoggerHandles {
  const info = vi.fn();
  const logger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, info };
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
      issueNumber: 1134,
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
    issueUrl: 'https://github.com/test/repo/issues/1134',
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

function targetedValidateEvent(info: ReturnType<typeof vi.fn>) {
  return info.mock.calls
    .map((c) => c[0])
    .find((arg) => arg && typeof arg === 'object' && arg.event === 'targeted-validate');
}

describe('PhaseLoop targeted-validate (#1134 T007)', () => {
  let phaseLoop: PhaseLoop;
  let workspaceDir: string;
  let plainDir: string;

  beforeEach(async () => {
    // Workspace checkout: pnpm-workspace.yaml present → isWorkspace true.
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-ws-'));
    await fs.writeFile(path.join(workspaceDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Non-workspace checkout: no pnpm-workspace.yaml → isWorkspace false.
    plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-plain-'));
    const { logger } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(plainDir, { recursive: true, force: true });
  });

  it('bugfix + targeted diff + built-in default → filtered build&&test + log emitted (SC-003)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['packages/a/src/x.ts', 'packages/b/src/y.ts'],
      logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test',
      context.signal,
    );
    const event = targetedValidateEvent(info);
    expect(event).toMatchObject({
      event: 'targeted-validate',
      classification: 'targeted',
      isBuiltInDefault: true,
      base: 'develop',
    });
  });

  it('bugfix + custom validate command → runs verbatim while classification still logged', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['packages/a/src/x.ts'],
      logger,
    );

    await phaseLoop.executeLoop(
      context,
      createConfig({ validateCommand: 'make check' }),
      deps,
      ['validate'],
    );

    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'make check', context.signal);
    const event = targetedValidateEvent(info);
    expect(event).toMatchObject({
      classification: 'targeted',
      isBuiltInDefault: false,
      effectiveCommand: 'make check',
    });
  });

  it('feature workflow → block skipped, plain default runs, no targeted-validate log (SC-005)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-feature',
      ['packages/a/src/x.ts'],
      logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
    expect(targetedValidateEvent(info)).toBeUndefined();
  });

  it('docs-only guard → filtered build only', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['README.md', 'docs/guide.md'],
      makeLogger().logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/develop]" build',
      context.signal,
    );
  });

  it('test-only guard → pnpm vitest run <files>', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['packages/a/src/x.test.ts', 'packages/a/src/__tests__/y.ts'],
      makeLogger().logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm vitest run packages/a/src/x.test.ts packages/a/src/__tests__/y.ts',
      context.signal,
    );
  });

  it('single-package guard (not a workspace) → default runs verbatim', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      plainDir,
      'speckit-bugfix',
      ['src/index.ts'],
      makeLogger().logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      plainDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
  });

  it('full-fallback guard (root lockfile touched) → default runs verbatim', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['pnpm-lock.yaml', 'packages/a/src/x.ts'],
      makeLogger().logger,
    );

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
  });
});
