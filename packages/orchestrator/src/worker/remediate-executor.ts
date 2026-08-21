/**
 * Remediate phase executor (#1128, FR-002/003/004).
 *
 * Replaces #1121's inert `runStubPhase('remediate')` with a real phase: read the
 * open blocking findings from the engine-written review sidecar (#1124), build an
 * in-process remediation charter, and spawn the CLI to make the code changes that
 * resolve them. The executor deliberately does NOT resolve review threads, mark
 * the PR ready, or write any GitHub review state — verification happens in the
 * NEXT review round, which recomputes the verdict from a fresh diff (FR-004).
 *
 * The review↔remediate loop is bounded by `remediationCount` (distinct from the
 * monotonic `round`, #1126): this executor increments it by exactly one on EVERY
 * return path (normal exit, timeout-kill, spawn failure) so a perpetually
 * timing-out attempt still consumes budget and eventually escalates (Q4=A,
 * SC-001/INV-1/INV-2).
 *
 * Spawns via `agentLauncher.launch()` directly (mirroring `review-executor.ts` /
 * `pr-feedback-handler.ts`), NOT `cli-spawner.spawnPhase` — the spawner
 * type-excludes `remediate` by construction.
 */
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { RemediateIntent } from '@generacy-ai/generacy-plugin-claude-code';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import type { WorkerConfig } from './config.js';
import {
  resolveReviewLikeAgent,
  resolvePhaseTimeoutMs,
  resolveWorkflowOverrides,
} from './config.js';
import { buildLaunchCredentials } from './credentials-helper.js';
import { warnIfEffortDropped } from './effort-mechanism-check.js';
import { OutputCapture } from './output-capture.js';
import { buildRemediateCharter } from './remediate-charter.js';
import {
  bumpRemediationCount,
  readReviewArtifact,
  SEVERITY_RANK,
  type ReviewFinding,
} from './review-artifact.js';
import type { Logger, PhaseResult, WorkerContext } from './types.js';

export interface RemediateExecutorDeps {
  agentLauncher: AgentLauncher;
  config: WorkerConfig;
  settings: OrchestratorSettings | null | undefined;
  logger: Logger;
}

export class RemediateExecutor {
  private readonly agentLauncher: AgentLauncher;
  private readonly config: WorkerConfig;
  private readonly settings: OrchestratorSettings | null | undefined;
  private readonly logger: Logger;

  constructor(deps: RemediateExecutorDeps) {
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

    // 1. Resolve remediate config (blockingSeverity) for this workflow.
    const { review } = resolveWorkflowOverrides(this.config, this.settings, workflowName);
    const { blockingSeverity } = review;

    // 2. Read the engine-written review artifact; filter to open blocking
    //    findings (same predicate `computeVerdict` uses).
    const artifact = await readReviewArtifact(checkoutPath, workflowId);
    const threshold = SEVERITY_RANK[blockingSeverity];
    const openBlocking: ReviewFinding[] = (artifact?.findings ?? []).filter(
      (f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= threshold,
    );
    const round = artifact?.round ?? 0;
    const remediationCount = artifact?.remediationCount ?? 0;

    // 3. Build the in-process remediation charter (findings-only for now; #1129
    //    appends a "Validate failures to fix" section without restructuring).
    const charter = buildRemediateCharter({
      findings: openBlocking,
      round,
      remediationCount,
      blockingSeverity,
    });

    // 4. Resolve the agent for remediation — prefer the `phases.remediate` tier and
    //    fall back field-by-field to the `implement` agent so the same model that
    //    wrote the code fixes it when unset (#1160 FR-005; the `review` tier is never
    //    consulted, so a cheaper review model cannot downgrade remediation).
    const { provider, model, effort } = resolveReviewLikeAgent(
      this.config,
      workflowName,
      'remediate',
    );

    warnIfEffortDropped(this.logger, {
      provider,
      effort,
      context: { handler: 'remediate', workflowId, issueNumber },
    });

    const timeoutMs = resolvePhaseTimeoutMs(this.config, 'remediate');
    this.logger.info(
      {
        cwd: checkoutPath,
        timeoutMs,
        provider,
        model,
        effort,
        round,
        remediationCount,
        findingCount: openBlocking.length,
      },
      'Spawning Claude CLI for remediate phase',
    );

    // 5. Spawn via the launcher directly (NOT cli-spawner, which excludes remediate).
    let child;
    try {
      const handle = await this.agentLauncher.launch({
        intent: {
          kind: 'remediate',
          issueNumber,
          prompt: charter,
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
        } as RemediateIntent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
        provider,
      });
      child = handle.process;
    } catch (error) {
      // Spawn failure still consumes remediation budget (Q4=A / INV-2).
      await this.bumpBudget(checkoutPath, workflowId);
      this.logger.error(
        { error: String(error), cwd: checkoutPath },
        'Failed to spawn Claude CLI for remediate',
      );
      return {
        phase: 'remediate',
        success: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        output: [],
      };
    }

    // 6. Manage the child: capture output + SIGTERM→grace→SIGKILL timeout.
    const outputCapture = new OutputCapture(workflowId, this.logger);
    let timedOut = false;

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
      timedOut = true;
      this.logger.warn(
        { pid: child.pid, timeoutMs },
        'Remediate CLI timed out — sending SIGTERM',
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
      // Wait-error (incl. timeout-kill) still consumes budget (Q4=A / INV-2).
      await this.bumpBudget(checkoutPath, workflowId);
      this.logger.error(
        { error: String(error) },
        'Error waiting for remediate CLI process',
      );
      return {
        phase: 'remediate',
        success: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        output: outputCapture.getOutput(),
        timedOut,
      };
    }
    clearTimeout(timeoutTimer);
    outputCapture.flush();

    if (stderrBuffer.trim()) {
      this.logger.debug({ stderr: stderrBuffer.trim() }, 'Remediate CLI stderr output');
    }

    // 7. Normal-exit path also consumes budget (Q4=A / SC-001 / INV-1).
    const newCount = await this.bumpBudget(checkoutPath, workflowId);

    this.logger.info(
      { exitCode, round, remediationCount: newCount, findingCount: openBlocking.length },
      'Remediate phase complete — remediation budget consumed',
    );

    // 8. `success` reflects the CLI exit; the loop backtracks to `review`
    //    regardless — the next review round recomputes the verdict.
    return {
      phase: 'remediate',
      success: exitCode === 0,
      exitCode: exitCode ?? -1,
      durationMs: Date.now() - startedAt,
      output: outputCapture.getOutput(),
      timedOut,
    };
  }

  /**
   * Increment `remediationCount` by exactly one (best-effort). A bump failure
   * must not fail the phase — the loop still backtracks to `review`.
   */
  private async bumpBudget(checkoutPath: string, workflowId: string): Promise<number> {
    try {
      return await bumpRemediationCount(checkoutPath, workflowId);
    } catch (error) {
      this.logger.warn(
        { error: String(error), workflowId },
        'Failed to bump remediationCount — continuing',
      );
      return 0;
    }
  }
}
