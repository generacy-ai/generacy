/**
 * Review phase executor (#1124, FR-002/003/004/005/006/007).
 *
 * Replaces #1121's inert `runStubPhase('review')` with a real phase: build an
 * in-process charter prompt (selected by `review.profile`), spawn the CLI via
 * the new `review` launch intent, let the agent write a structured findings
 * sidecar, then have the ENGINE Zod-validate the findings and RECOMPUTE the
 * verdict. The agent-claimed verdict — if any — is ignored (FR-007), and no
 * GitHub review state is ever written (the cluster account 422s on
 * `REQUEST_CHANGES` on its own PR).
 *
 * Spawns via `agentLauncher.launch()` directly (mirroring
 * `pr-feedback-handler.ts`), NOT `cli-spawner.spawnPhase` — the spawner
 * type-excludes `review` by construction.
 */
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { ReviewIntent } from '@generacy-ai/generacy-plugin-claude-code';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { WorkerConfig } from './config.js';
import {
  resolveAgentForPhase,
  resolvePhaseTimeoutMs,
  resolveWorkflowOverrides,
} from './config.js';
import { buildLaunchCredentials } from './credentials-helper.js';
import { warnIfEffortDropped } from './effort-mechanism-check.js';
import { OutputCapture } from './output-capture.js';
import { buildReviewCharter } from './review-charter.js';
import {
  computeVerdict,
  getReviewArtifactRelPath,
  readCandidateFindings,
  readReviewArtifact,
  writeReviewArtifact,
} from './review-artifact.js';
import type { Logger, PhaseResult, WorkerContext } from './types.js';

export interface ReviewExecutorDeps {
  agentLauncher: AgentLauncher;
  config: WorkerConfig;
  settings: OrchestratorSettings | null | undefined;
  logger: Logger;
}

/**
 * The review-phase executor contract the phase loop depends on. Lets the loop
 * accept either the real {@link ReviewExecutor} or the #1130
 * `SeedAwareReviewExecutor` wrapper in the `deps.reviewExecutor` slot without a
 * nominal-class coupling (private fields make the concrete classes
 * non-interchangeable under structural typing).
 */
export interface ReviewExecutorLike {
  execute(context: WorkerContext): Promise<PhaseResult>;
}

export class ReviewExecutor implements ReviewExecutorLike {
  private readonly agentLauncher: AgentLauncher;
  private readonly config: WorkerConfig;
  private readonly settings: OrchestratorSettings | null | undefined;
  private readonly logger: Logger;

  constructor(deps: ReviewExecutorDeps) {
    this.agentLauncher = deps.agentLauncher;
    this.config = deps.config;
    this.settings = deps.settings;
    this.logger = deps.logger;
  }

  async execute(context: WorkerContext): Promise<PhaseResult> {
    const startedAt = Date.now();
    const { checkoutPath } = context;
    const { owner, repo, issueNumber, workflowName } = context.item;
    const workflowId = `${owner}/${repo}#${issueNumber}`;

    // 1. Resolve review config (profile / blockingSeverity) for this workflow.
    const { review } = resolveWorkflowOverrides(this.config, this.settings, workflowName);
    const { profile, blockingSeverity } = review;

    // 2. Determine the review round from any prior engine-written artifact.
    const priorRound = await readReviewArtifact(checkoutPath, workflowId);
    const round = (priorRound?.round ?? 0) + 1;

    // 3. Build the in-process charter naming the agent's sidecar write target.
    const sidecarRelPath = getReviewArtifactRelPath(workflowId);
    const charter = buildReviewCharter({ profile, sidecarRelPath, blockingSeverity, round });

    // 4. Resolve the agent for this review — reuse the `implement` agent so the
    //    same model that wrote the code reviews it (mirrors pr-feedback, #814).
    const { provider, model, effort } = resolveAgentForPhase(
      this.config,
      workflowName,
      'implement',
    );

    warnIfEffortDropped(this.logger, {
      provider,
      effort,
      context: { handler: 'review', workflowId, issueNumber },
    });

    const timeoutMs = resolvePhaseTimeoutMs(this.config, 'review');
    this.logger.info(
      { cwd: checkoutPath, timeoutMs, provider, model, effort, round, profile },
      'Spawning Claude CLI for review phase',
    );

    // 5. Spawn via the launcher directly (NOT cli-spawner, which excludes review).
    let child;
    try {
      const handle = await this.agentLauncher.launch({
        intent: {
          kind: 'review',
          issueNumber,
          prompt: charter,
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
        } as ReviewIntent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
        provider,
      });
      child = handle.process;
    } catch (error) {
      this.logger.error(
        { error: String(error), cwd: checkoutPath },
        'Failed to spawn Claude CLI for review',
      );
      return {
        phase: 'review',
        success: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        output: [],
      };
    }

    // 6. Manage the child: capture output + SIGTERM→grace→SIGKILL timeout.
    const outputCapture = new OutputCapture(workflowId, this.logger);

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer | string) => {
        outputCapture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    let stderrBuffer = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer | string) => {
        stderrBuffer += typeof data === 'string' ? data : data.toString('utf-8');
      });
    }

    const timeoutTimer = setTimeout(() => {
      this.logger.warn(
        { pid: child.pid, timeoutMs },
        'Review CLI timed out — sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.pid) {
          this.logger.warn(
            { pid: child.pid, gracePeriodMs: this.config.shutdownGracePeriodMs },
            'Grace period expired, sending SIGKILL',
          );
          child.kill('SIGKILL');
        }
      }, this.config.shutdownGracePeriodMs);
    }, timeoutMs);

    let exitCode: number | null;
    try {
      exitCode = await child.exitPromise;
    } catch (error) {
      clearTimeout(timeoutTimer);
      outputCapture.flush();
      this.logger.error(
        { error: String(error) },
        'Error waiting for review CLI process',
      );
      return {
        phase: 'review',
        success: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        output: outputCapture.getOutput(),
      };
    }
    clearTimeout(timeoutTimer);
    outputCapture.flush();

    if (stderrBuffer.trim()) {
      this.logger.debug({ stderr: stderrBuffer.trim() }, 'Review CLI stderr output');
    }

    // 7. Read the agent-written candidate sidecar; validate findings, stamping
    //    the authoritative round (tolerates a looser candidate verdict/round).
    const findings = await readCandidateFindings(checkoutPath, workflowId, round);

    // 8. Compute the verdict from the findings — ignore any agent claim (FR-007).
    const verdict = computeVerdict(findings, blockingSeverity);

    // 9. Stamp the commit reviewed.
    const lastReviewedCommitSha = await context.github.getCurrentCommitSha();

    // 10. Persist the engine-authoritative artifact atomically.
    await writeReviewArtifact(checkoutPath, workflowId, {
      findings,
      verdict,
      round,
      lastReviewedCommitSha,
    });

    this.logger.info(
      { verdict, round, findingCount: findings.length, exitCode, lastReviewedCommitSha },
      'Review phase complete — verdict computed by engine',
    );

    // 11. The review phase itself always succeeds (the verdict drives the
    //     downstream remediate seam, not the phase's success flag).
    return {
      phase: 'review',
      success: true,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: outputCapture.getOutput(),
    };
  }
}
