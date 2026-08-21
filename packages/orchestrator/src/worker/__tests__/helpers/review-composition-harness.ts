/**
 * Composition harness for the composed review-loop integration suite (#1168,
 * T003). It wires the REAL `ReviewExecutor` + `computeVerdict` into a real
 * `PhaseLoop.executeLoop` via the spawning `AgentLauncher` double
 * (`spawning-agent-launcher.ts` → `fixtures/scripted-review-cli.mjs`), so the
 * verdict is recomputed by production code — never steered by a stub. That is
 * the whole point of #1168: catch the "seam passes, production fails" class the
 * earlier `readFindingsArtifact`-steered suites masked (#1155/#1156/#1154).
 *
 * Deliberately does NOT wire `deps.readFindingsArtifact` — injecting it would
 * re-introduce the verdict-steering seam this feature exists to remove
 * (SC-002). The posting side-effect block therefore never runs here; the
 * composed suite asserts against the engine-written artifact via
 * `readReviewArtifact`, and posting/lifecycle assertions live in the re-pointed
 * clean-review suite (T020/T021).
 *
 * Scenario shape:
 *  - write/withhold (missing-sidecar) paths inject a real spawning launcher via
 *    `makeSpawningLauncher()` (Q2→A);
 *  - the timeout and non-zero-exit paths inject a mocked hanging
 *    `ChildProcessHandle` launcher constructed by the test itself, plus a
 *    hand-built `WorkerConfig` (never `.parse()`d) with sub-60s timeouts.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { GitHubClient, Review } from '@generacy-ai/workflow-engine';
import type { AgentLauncher } from '../../../launcher/agent-launcher.js';
import type { WorkerConfig } from '../../config.js';
import { PhaseLoop } from '../../phase-loop.js';
import type { PhaseLoopDeps } from '../../phase-loop.js';
import { ReviewExecutor } from '../../review-executor.js';
import { getPhaseSequence } from '../../types.js';
import type { Logger, PhaseResult, WorkerContext, WorkflowPhase } from '../../types.js';
import {
  createSpawningAgentLauncherAsLauncher,
  type SpawningLauncherEnv,
} from './spawning-agent-launcher.js';

type BlockingSeverity = 'critical' | 'major' | 'minor';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/**
 * A recording fake `GitHubClient`. Merges the poster surface (empty
 * `listReviews` / `listPullRequestFiles` / `getPRReviewThreads`, capturing
 * `createReview`) with the executor + delta surface the review phase queries
 * (`getDefaultBranch` / `getCurrentCommitSha` / `commitExistsInCheckout` /
 * `getFilesChanged*`). Non-empty changed-file lists so the implement phase's
 * product-diff guard passes; `commitExistsInCheckout` true so the phase-start
 * ref is reused rather than re-captured.
 */
export function createRecordingGithub(): GitHubClient {
  const createReview = vi.fn(
    async (): Promise<Review> => ({
      id: 1,
      user: { login: 'generacy[bot]' },
      body: '',
      state: 'COMMENTED',
      submittedAt: new Date().toISOString(),
    }),
  );
  return {
    // Poster surface.
    listReviews: vi.fn(async () => [] as Review[]),
    listPullRequestFiles: vi.fn(async () => []),
    getPRReviewThreads: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => undefined),
    createReview,
    // Executor + delta surface.
    getDefaultBranch: vi.fn(async () => 'develop'),
    getCurrentCommitSha: vi.fn(async () => 'a1b2c3d4'),
    commitExistsInCheckout: vi.fn(async () => true),
    getFilesChangedByOwnCommits: vi.fn(async () => ['packages/orchestrator/src/foo.ts']),
    getFilesChangedBetween: vi.fn(async () => ['packages/orchestrator/src/foo.ts']),
    getIssue: vi.fn(async () => ({ labels: [] })),
    addIssueComment: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
  } as unknown as GitHubClient;
}

/** Per-scenario knobs the composed suite varies. */
export interface BuildScenarioOptions {
  /** The launcher the review executor spawns through (real double or mocked handle). */
  agentLauncher: AgentLauncher;
  /**
   * Drives `resolveWorkflowOverrides(...).review.blockingSeverity`. When set,
   * threaded into BOTH the `ReviewExecutor` `settings` and `PhaseLoopDeps.settings`
   * so the executor and the loop agree. Omit to fall back to the per-workflow
   * built-in default.
   */
  blockingSeverity?: BlockingSeverity;
  phaseTimeoutMs?: number;
  shutdownGracePeriodMs?: number;
  startPhase?: WorkflowPhase;
  /** Merged last onto the built `PhaseLoopDeps` (e.g. `remediateTrigger`). */
  extraDeps?: Partial<PhaseLoopDeps>;
}

export interface BuiltScenario {
  context: WorkerContext;
  config: WorkerConfig;
  deps: PhaseLoopDeps;
  settings: OrchestratorSettings;
  sequence: WorkflowPhase[];
}

export interface ReviewCompositionHarness {
  checkoutPath: string;
  workflowId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  github: GitHubClient;
  logger: Logger;
  phaseLoop: PhaseLoop;
  /**
   * Build a real spawning launcher for the write/withhold path. `checkoutPath`
   * and `workflowId` are filled from the harness so the fixture derives the same
   * candidate path the engine reads.
   */
  makeSpawningLauncher(env: { mode: 'write' | 'withhold'; candidateJson?: string }): AgentLauncher;
  /** Compose a `{ context, config, deps, settings, sequence }` bundle to hand to `executeLoop`. */
  build(opts: BuildScenarioOptions): BuiltScenario;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  workflowName?: string;
}

export async function createReviewCompositionHarness(
  opts: HarnessOptions = {},
): Promise<ReviewCompositionHarness> {
  const owner = opts.owner ?? 'test';
  const repo = opts.repo ?? 'repo';
  const issueNumber = opts.issueNumber ?? 1168;
  const workflowName = opts.workflowName ?? 'speckit-feature';
  const workflowId = `${owner}/${repo}#${issueNumber}`;

  const checkoutPath = await mkdtemp(path.join(tmpdir(), 'review-composition-'));
  await mkdir(path.join(checkoutPath, '.generacy'), { recursive: true });

  // Isolate git config so the fixture checkout never touches the host identity.
  const homeDir = await mkdtemp(path.join(tmpdir(), 'review-composition-home-'));
  const gitEnv = {
    ...process.env,
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: path.join(homeDir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  execFileSync('git', ['init', '-q'], { cwd: checkoutPath, env: gitEnv });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: checkoutPath,
    env: gitEnv,
  });
  execFileSync('git', ['config', 'user.name', 'Review Composition Harness'], {
    cwd: checkoutPath,
    env: gitEnv,
  });

  const github = createRecordingGithub();
  const phaseLoop = new PhaseLoop(mockLogger);

  function createConfig(overrides: Partial<WorkerConfig>): WorkerConfig {
    return {
      phaseTimeoutMs: 600_000,
      workspaceDir: checkoutPath,
      shutdownGracePeriodMs: 5000,
      validateCommand: 'pnpm test && pnpm build',
      preValidateCommand: '',
      reviewPhaseEnabled: true,
      gates: {},
      maxImplementRetries: 2,
      ...overrides,
    } as WorkerConfig;
  }

  function createDeps(reviewExecutor: ReviewExecutor, settings: OrchestratorSettings): PhaseLoopDeps {
    return {
      labelManager: {
        onPhaseStart: vi.fn().mockResolvedValue(undefined),
        onPhaseComplete: vi.fn().mockResolvedValue(undefined),
        onError: vi.fn().mockResolvedValue(undefined),
        onGateHit: vi.fn().mockResolvedValue(undefined),
      } as unknown as PhaseLoopDeps['labelManager'],
      stageCommentManager: {
        updateStageComment: vi.fn().mockResolvedValue(undefined),
        postFailureAlert: vi.fn().mockResolvedValue(undefined),
      } as unknown as PhaseLoopDeps['stageCommentManager'],
      gateChecker: {
        checkGates: vi.fn().mockReturnValue([]),
      } as unknown as PhaseLoopDeps['gateChecker'],
      cliSpawner: {
        spawnPhase: vi
          .fn()
          .mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
        runValidatePhase: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
        runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
      } as unknown as PhaseLoopDeps['cliSpawner'],
      outputCapture: {
        processChunk: vi.fn(),
        flush: vi.fn(),
        getOutput: vi.fn().mockReturnValue([]),
        clear: vi.fn(),
      } as unknown as PhaseLoopDeps['outputCapture'],
      prManager: {
        commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
        getPrNumber: vi.fn().mockReturnValue(42),
        convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
        markReadyForReview: vi.fn().mockResolvedValue(undefined),
      } as unknown as PhaseLoopDeps['prManager'],
      reviewExecutor,
      settings,
    };
  }

  function createContext(startPhase: WorkflowPhase): WorkerContext {
    return {
      workerId: 'test-worker',
      item: { owner, repo, issueNumber, workflowName } as WorkerContext['item'],
      startPhase,
      github,
      logger: mockLogger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
      description: 'test',
      // No prUrl → resolvePrBaseRef falls back to origin/<defaultBranch>.
    };
  }

  return {
    checkoutPath,
    workflowId,
    owner,
    repo,
    issueNumber,
    workflowName,
    github,
    logger: mockLogger,
    phaseLoop,

    makeSpawningLauncher({ mode, candidateJson }) {
      const env: SpawningLauncherEnv = {
        FIXTURE_CHECKOUT_PATH: checkoutPath,
        FIXTURE_WORKFLOW_ID: workflowId,
        FIXTURE_MODE: mode,
        ...(candidateJson !== undefined ? { FIXTURE_CANDIDATE_JSON: candidateJson } : {}),
      };
      return createSpawningAgentLauncherAsLauncher(env);
    },

    build({
      agentLauncher,
      blockingSeverity,
      phaseTimeoutMs = 600_000,
      shutdownGracePeriodMs = 5000,
      startPhase = 'implement',
      extraDeps,
    }): BuiltScenario {
      const settings = (
        blockingSeverity
          ? { workflows: { [workflowName]: { review: { blockingSeverity } } } }
          : { workflows: {} }
      ) as OrchestratorSettings;

      const config = createConfig({ phaseTimeoutMs, shutdownGracePeriodMs });
      const reviewExecutor = new ReviewExecutor({
        agentLauncher,
        config,
        settings,
        logger: mockLogger,
      });
      const deps: PhaseLoopDeps = { ...createDeps(reviewExecutor, settings), ...extraDeps };
      const context = createContext(startPhase);
      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      return { context, config, deps, settings, sequence };
    },

    async cleanup() {
      await rm(checkoutPath, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    },
  };
}
