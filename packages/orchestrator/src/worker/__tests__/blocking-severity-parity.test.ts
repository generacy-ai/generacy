// #1161 T022 (US3 / SC-004) — blockingSeverity override parity.
//
// One resolved `blockingSeverity` (from `resolveWorkflowOverrides`) must drive an
// IDENTICAL verdict across all four consumers for the same findings set:
//   1. review executor      — persists `computeVerdict(merged, bs)`
//   2. remediate executor    — filters open findings at/above the threshold
//   3. gate (phase-loop)     — reads the executor-persisted `artifact.verdict`
//   4. convergence merge     — `advanceArtifact(...)` → `computeVerdict(merged, bs)`
//
// The fixture is a single OPEN `major` finding whose verdict flips with the
// threshold: at `major` it blocks (changes-required); at `critical` it does not
// (clean). speckit-feature defaults to `major`; a per-workflow override to
// `critical` flips it. Both cases are asserted, proving no consumer has its own
// private threshold.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, WorkerContext } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { resolveWorkflowOverrides } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ReviewExecutor } from '../review-executor.js';
import {
  SEVERITY_RANK,
  computeVerdict,
  getReviewCandidatePath,
  readReviewArtifact,
  type ReviewFinding,
} from '../review-artifact.js';
import { advanceArtifact } from '../review/findings-advance.js';
import type { ReviewDelta } from '../review/review-delta.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

/** One OPEN `major` finding — the verdict pivot for this parity suite. */
const FINDINGS: ReviewFinding[] = [
  {
    id: 'f-major',
    severity: 'major',
    file: 'src/a.ts',
    title: 'Unhandled promise rejection',
    detail: 'Promise is not awaited; failure is swallowed.',
    round: 1,
    status: 'open',
  },
];

type Verdict = 'clean' | 'changes-required';

/**
 * Consumer 2 — the remediate executor's open-blocking filter
 * (`remediate-executor.ts`). It never names a verdict, but a non-empty
 * open-blocking set is exactly the `changes-required` condition.
 */
function remediateVerdict(findings: ReviewFinding[], blockingSeverity: 'critical' | 'major' | 'minor'): Verdict {
  const threshold = SEVERITY_RANK[blockingSeverity];
  const openBlocking = findings.filter(
    (f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= threshold,
  );
  return openBlocking.length > 0 ? 'changes-required' : 'clean';
}

/**
 * Consumer 4 — the convergence merge (`advanceArtifact` → `computeVerdict`).
 * A round-1 delta keeps every candidate (no threshold pre-filter), so the
 * threshold is applied solely by `computeVerdict`, matching the executor.
 */
function convergenceVerdict(findings: ReviewFinding[], blockingSeverity: 'critical' | 'major' | 'minor'): Verdict {
  const delta: ReviewDelta = {
    base: { source: 'full-diff', base: 'main', head: 'HEAD' },
    files: [],
    round: 1,
  };
  const merged = advanceArtifact(null, delta, [], findings, blockingSeverity);
  return computeVerdict(merged, blockingSeverity);
}

const baseConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'echo validate',
  gates: {},
} as WorkerConfig;

/** Per-workflow override forcing speckit-feature's blockingSeverity to `critical`. */
const OVERRIDE_CRITICAL = {
  workflows: { 'speckit-feature': { review: { blockingSeverity: 'critical' } } },
} as unknown as OrchestratorSettings;

interface ParityCase {
  name: string;
  settings: OrchestratorSettings | null;
  expectedBlockingSeverity: 'critical' | 'major' | 'minor';
  expectedVerdict: Verdict;
}

const CASES: ParityCase[] = [
  {
    name: 'default speckit-feature (major) → the open major finding blocks',
    settings: null,
    expectedBlockingSeverity: 'major',
    expectedVerdict: 'changes-required',
  },
  {
    name: 'override to critical → the open major finding no longer blocks',
    settings: OVERRIDE_CRITICAL,
    expectedBlockingSeverity: 'critical',
    expectedVerdict: 'clean',
  },
];

describe('#1161 blockingSeverity override parity (SC-004)', () => {
  let checkoutPath: string;
  const workflowId = 'owner/repo#42';

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'bs-parity-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  function makeContext(github: GitHubClient): WorkerContext {
    const item: QueueItem = {
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'review',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: { phase: 'review' },
    };
    return {
      workerId: 'w1',
      jobId: 'j1',
      item,
      startPhase: 'review',
      github,
      logger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      description: 'test',
    } as WorkerContext;
  }

  function makeGithub(): GitHubClient {
    return {
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(false),
      getFilesChangedBetween: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;
  }

  function makeProcess(exitCode = 0): ChildProcessHandle {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let resolveExit: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const handle: ChildProcessHandle = {
      stdin: null,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      pid: 4242,
      kill: vi.fn((sig?: string) => {
        if (sig === 'SIGTERM' || sig === 'SIGKILL') resolveExit(exitCode);
        return true;
      }),
      exitPromise,
    };
    setTimeout(() => resolveExit(exitCode), 5);
    return handle;
  }

  /** Launcher that writes the agent candidate sidecar (one open major finding). */
  function makeLauncher(): AgentLauncher {
    const launch = vi.fn(async () => {
      const filePath = getReviewCandidatePath(checkoutPath, workflowId);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          verdict: 'clean', // agent-claimed — ignored; engine recomputes
          findings: [
            {
              severity: 'major',
              file: 'src/a.ts',
              title: 'Unhandled promise rejection',
              detail: 'Promise is not awaited; failure is swallowed.',
            },
          ],
        }),
        'utf-8',
      );
      return {
        process: makeProcess(0),
        outputParser: { processChunk: () => undefined, flush: () => undefined },
        metadata: { pluginId: 'claude-code', intentKind: 'review' },
      };
    });
    return { launch } as unknown as AgentLauncher;
  }

  it.each(CASES)('resolves the expected blockingSeverity — $name', ({ settings, expectedBlockingSeverity }) => {
    const resolved = resolveWorkflowOverrides(baseConfig, settings, 'speckit-feature');
    expect(resolved.review.blockingSeverity).toBe(expectedBlockingSeverity);
  });

  it.each(CASES)(
    'pure consumers (verdict, remediate filter, convergence) agree — $name',
    ({ settings, expectedVerdict }) => {
      const bs = resolveWorkflowOverrides(baseConfig, settings, 'speckit-feature').review
        .blockingSeverity;

      // Consumer 1 source (executor persist) + Consumer 3 source (gate reads it).
      expect(computeVerdict(FINDINGS, bs)).toBe(expectedVerdict);
      // Consumer 2 (remediate open-blocking filter).
      expect(remediateVerdict(FINDINGS, bs)).toBe(expectedVerdict);
      // Consumer 4 (convergence merge).
      expect(convergenceVerdict(FINDINGS, bs)).toBe(expectedVerdict);
    },
  );

  it.each(CASES)(
    'the live ReviewExecutor persists the same verdict the gate reads — $name',
    async ({ settings, expectedVerdict }) => {
      const executor = new ReviewExecutor({
        agentLauncher: makeLauncher(),
        config: baseConfig,
        settings,
        logger,
      });

      await executor.execute(makeContext(makeGithub()));

      // The gate (`phase-loop.ts` on-remediation-limit) reads this persisted
      // field verbatim — so the executor + gate share one verdict by construction.
      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted).not.toBeNull();
      expect(persisted!.verdict).toBe(expectedVerdict);
    },
  );
});
