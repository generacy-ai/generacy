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
// #1134 T007 (US2 / SC-003 / SC-005) + #1166 T014 (US1 / US2 / US5)
//
// Drives executeLoop through the validate phase and asserts the effective
// validate command the classifier resolves for speckit-bugfix, plus the single
// structured `targeted-validate` log line. Every non-bugfix workflow reaches the
// plain default unchanged (SC-005 byte-identity).
//
// #1166 additions:
//   - existence-filter: a deletion-only / rename diff must never emit
//     `pnpm vitest run <nonexistent-file>` (FR-001/FR-002, SC-001).
//   - zero-project fallback: a root-only non-package diff that classifies
//     `targeted` but selects zero pnpm projects falls back to the full default
//     (FR-003, SC-002). The `pnpm ls` probe is routed through the mocked
//     `node:child_process` execFile so its selection is controllable.
//   - `<base>` substitution: a custom command with `<base>` is substituted with
//     the resolved base branch on both develop- and main-based repos (FR-010,
//     SC-006).
// ---------------------------------------------------------------------------

// The zero-project probe shells out to `pnpm ls … --json`. Route it through a
// controllable mock so the temp-dir checkout (which is not a git repo) does not
// drive the result. Default: a non-empty selection (probe does NOT force the
// full fallback), so a genuine `targeted`/`docs-only` classification is honored.
let probeStdout = '[{"name":"pkg-a","path":"/tmp/packages/a"}]';
let probeError = false;
const execFileSpy = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, res?: { stdout: string; stderr: string }) => void;
    if (probeError) {
      callback(new Error('pnpm ls failed'));
      return;
    }
    callback(null, { stdout: probeStdout, stderr: '' });
  },
);
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileSpy as unknown as (...a: unknown[]) => void)(...args),
}));

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
  base = 'develop',
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
      getDefaultBranch: vi.fn().mockResolvedValue(base),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: base } }),
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

function targetedValidateEvents(info: ReturnType<typeof vi.fn>) {
  return info.mock.calls
    .map((c) => c[0])
    .filter((arg) => arg && typeof arg === 'object' && arg.event === 'targeted-validate');
}

describe('PhaseLoop targeted-validate (#1134 T007 / #1166 T014)', () => {
  let phaseLoop: PhaseLoop;
  let workspaceDir: string;
  let plainDir: string;

  /** Materialize changed paths in the checkout so the existsSync filter keeps them. */
  async function writeFiles(dir: string, files: string[]): Promise<void> {
    for (const f of files) {
      const full = path.join(dir, f);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, '// present\n');
    }
  }

  beforeEach(async () => {
    // Workspace checkout: pnpm-workspace.yaml present → isWorkspace true.
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-ws-'));
    await fs.writeFile(path.join(workspaceDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Non-workspace checkout: no pnpm-workspace.yaml → isWorkspace false.
    plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-plain-'));
    const { logger } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    // Probe defaults: non-empty selection, no error.
    probeStdout = '[{"name":"pkg-a","path":"/tmp/packages/a"}]';
    probeError = false;
    execFileSpy.mockClear();
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
    const changedFiles = ['packages/a/src/x.ts', 'packages/b/src/y.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, logger);

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

  it('bugfix + custom validate command (cluster tier) → runs verbatim while classification still logged', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, logger);

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

  it('bugfix + per-workflow custom validate command (settings.workflows) → runs verbatim, not rewritten (#1150 finding 3)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // Cluster default is left untouched; the operator sets a per-workflow override.
    deps.settings = {
      workflows: {
        'speckit-bugfix': { validateCommand: 'make check' },
      },
    } as any;
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, logger);

    // config.validateCommand stays the built-in default — the fix must resolve the
    // per-workflow tier instead of comparing the raw cluster default.
    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(workspaceDir, 'make check', context.signal);
    const event = targetedValidateEvent(info);
    expect(event).toMatchObject({
      classification: 'targeted',
      isBuiltInDefault: false,
      effectiveCommand: 'make check',
    });
  });

  it('bugfix + diff resolution throws → falls back to plain resolved command, no hard fail (#1150 finding 1)', async () => {
    const { logger } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const context = createContext(
      workspaceDir,
      'speckit-bugfix',
      ['packages/a/src/x.ts'],
      logger,
    );
    // Simulate `git diff base...HEAD` throwing (e.g. origin/<base> not fetched).
    (context.github.getFilesChangedBetween as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fatal: bad revision origin/develop...HEAD'),
    );

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    // Falls back to the plain resolved command (the built-in default) and does not
    // hard-fail the validate phase.
    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
    expect(result.completed).toBe(true);
  });

  it('feature workflow → block skipped, plain default runs, no targeted-validate log (SC-005)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-feature', changedFiles, logger);

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
    const changedFiles = ['README.md', 'docs/guide.md'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

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
    const changedFiles = ['packages/a/src/x.test.ts', 'packages/a/src/__tests__/y.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

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
    const changedFiles = ['src/index.ts'];
    await writeFiles(plainDir, changedFiles);
    const context = createContext(plainDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

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
    const changedFiles = ['pnpm-lock.yaml', 'packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
  });

  // -------------------------------------------------------------------------
  // #1166 T014 — existence filter (US1 / SC-001)
  // -------------------------------------------------------------------------

  it('deletion-only test diff → all paths filtered out → full fallback, no vitest run on nonexistent files (SC-001)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // The diff reports deleted test files; none are materialized in the checkout.
    const changedFiles = ['packages/a/src/gone.test.ts', 'packages/a/src/__tests__/gone.ts'];
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    // Empty filtered set → classifyDiff → full-fallback('empty-diff') → full default.
    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
    // Never emit a vitest run against a deleted path.
    const cmd = runValidatePhase.mock.calls[0]?.[1] as string;
    expect(cmd).not.toContain('vitest run');
    expect(cmd).not.toContain('gone.test.ts');
    expect(cmd).not.toContain('gone.ts');
  });

  it('rename (old deleted, new added) → validate never references the old path (SC-001)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // Old path deleted (absent); new path added (present on disk).
    const oldPath = 'packages/a/src/old-name.test.ts';
    const newPath = 'packages/a/src/new-name.test.ts';
    await writeFiles(workspaceDir, [newPath]);
    const context = createContext(workspaceDir, 'speckit-bugfix', [oldPath, newPath], makeLogger().logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    // Only the present (renamed-to) file survives the filter → test-only on it alone.
    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      `pnpm vitest run ${newPath}`,
      context.signal,
    );
    const cmd = runValidatePhase.mock.calls[0]?.[1] as string;
    expect(cmd).not.toContain(oldPath);
  });

  it('test-only diff whose files all still exist → runs exactly those files (SC-007 unchanged)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/keep.test.ts', 'packages/b/src/__tests__/also.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm vitest run packages/a/src/keep.test.ts packages/b/src/__tests__/also.ts',
      context.signal,
    );
  });

  // -------------------------------------------------------------------------
  // #1166 T014 — zero-project fallback (US2 / SC-002)
  // -------------------------------------------------------------------------

  it('root-only non-config diff classifies targeted but selects zero projects → full fallback + log (SC-002)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // scripts/** is not root-config, not docs, not test → classifies `targeted`,
    // yet `pnpm --filter …` selects no package. Probe returns an empty selection.
    probeStdout = '[]';
    const changedFiles = ['scripts/release.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
    // The probe was consulted, and exactly one zero-project-fallback line emitted.
    expect(execFileSpy).toHaveBeenCalled();
    const events = targetedValidateEvents(info);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'targeted-validate',
      reason: 'zero-project-fallback',
      base: 'develop',
      effectiveCommand: DEFAULT_VALIDATE_COMMAND,
    });
  });

  it('zero-project probe errors → fail-safe full fallback (SC-002)', async () => {
    const { logger, info } = makeLogger();
    phaseLoop = new PhaseLoop(logger);
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    probeError = true;
    const changedFiles = ['scripts/release.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      DEFAULT_VALIDATE_COMMAND,
      context.signal,
    );
    const events = targetedValidateEvents(info);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'zero-project-fallback' });
  });

  it('targeted diff that selects a project → probe passes, targeted command runs (SC-002 negative)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    // Non-empty probe selection (beforeEach default) → no fallback.
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test',
      context.signal,
    );
  });

  // -------------------------------------------------------------------------
  // #1166 T014 — <base> substitution (US5 / SC-006)
  // -------------------------------------------------------------------------

  it('custom validateCommand with <base> → substituted with resolved base (develop fixture, SC-006)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger, 'develop');

    await phaseLoop.executeLoop(
      context,
      createConfig({ validateCommand: 'pnpm --filter "...[origin/<base>]" test' }),
      deps,
      ['validate'],
    );

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/develop]" test',
      context.signal,
    );
  });

  it('custom validateCommand with <base> → substituted with resolved base (main fixture, SC-006)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger, 'main');

    await phaseLoop.executeLoop(
      context,
      createConfig({ validateCommand: 'pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test' }),
      deps,
      ['validate'],
    );

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/main]" build && pnpm --filter "...[origin/main]" test',
      context.signal,
    );
    // The literal placeholder must never survive into the emitted command.
    const cmd = runValidatePhase.mock.calls[0]?.[1] as string;
    expect(cmd).not.toContain('<base>');
  });

  it('built-in default path unchanged on a main-based repo (SC-006 control)', async () => {
    const runValidatePhase = vi.fn().mockResolvedValue(makeSuccessResult('validate'));
    const deps = createDeps(runValidatePhase);
    const changedFiles = ['packages/a/src/x.ts'];
    await writeFiles(workspaceDir, changedFiles);
    const context = createContext(workspaceDir, 'speckit-bugfix', changedFiles, makeLogger().logger, 'main');

    await phaseLoop.executeLoop(context, createConfig(), deps, ['validate']);

    expect(runValidatePhase).toHaveBeenCalledWith(
      workspaceDir,
      'pnpm --filter "...[origin/main]" build && pnpm --filter "...[origin/main]" test',
      context.signal,
    );
  });
});
