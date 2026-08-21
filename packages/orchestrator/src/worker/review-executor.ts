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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { ReviewIntent } from '@generacy-ai/generacy-plugin-claude-code';
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
import { buildReviewCharter } from './review-charter.js';
import {
  clearReviewCandidate,
  computeVerdict,
  getReviewCandidateRelPath,
  readCandidateFindings,
  readReviewArtifact,
  writeReviewArtifact,
} from './review-artifact.js';
import type { Logger, PhaseResult, WorkerContext } from './types.js';

const execFileAsync = promisify(execFile);

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

    // #1131: resolution-scoped review. When a merge-conflict re-arm supplied a
    // `reviewScope`, the review is scoped to just the resolution diff
    // (`baseSha..headSha`). An empty window means the resolution introduced no
    // changes over the pre-merge tip — nothing to review, so short-circuit to a
    // synthetic success (FR-011, SC-004) and let the loop advance to `validate`.
    // Absent scope ⇒ whole-PR review, byte-identical to pre-#1131 (FR-010).
    const { reviewScope } = context;
    if (reviewScope) {
      const isEmpty = await this.isEmptyWindow(checkoutPath, reviewScope);
      if (isEmpty) {
        this.logger.info(
          { baseSha: reviewScope.baseSha, headSha: reviewScope.headSha, workflowId },
          'Resolution-scoped review window is empty — skipping review, advancing to validate',
        );
        return {
          phase: 'review',
          success: true,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          output: [],
        };
      }
    }

    // 2. Determine the review round from any prior engine-written artifact.
    const priorRound = await readReviewArtifact(checkoutPath, workflowId);
    const round = (priorRound?.round ?? 0) + 1;

    // 3. Build the in-process charter naming the agent's sidecar write target.
    //    #1155: the agent writes the *candidate* path; the engine reads it and
    //    writes the authoritative artifact separately (INV-5).
    const sidecarRelPath = getReviewCandidateRelPath(workflowId);
    const charter = buildReviewCharter({
      profile,
      sidecarRelPath,
      blockingSeverity,
      round,
      ...(reviewScope ? { diffWindow: reviewScope } : {}),
    });

    // 4. Resolve the agent for this review — prefer the `phases.review` tier and
    //    fall back field-by-field to the `implement` agent so the same model that
    //    wrote the code reviews it when unset (#1160 FR-005; mirrors pr-feedback #814).
    const { provider, model, effort } = resolveReviewLikeAgent(
      this.config,
      workflowName,
      'review',
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

    // 5. Clear any stale candidate BEFORE spawning (#1155, INV D-3) so any
    //    candidate present after the spawn was provably written this round — a
    //    leftover from a crashed prior round can never be re-ingested.
    await clearReviewCandidate(checkoutPath, workflowId);

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

    // 7. Read the agent-written candidate sidecar. `null` = no proof of review
    //    (missing / unreadable / invalid) — a no-verdict round; `[]` = a genuine
    //    "reviewed, zero findings" (#1155, FR-002).
    const findings = await readCandidateFindings(checkoutPath, workflowId, round);

    // 8. Post-exit gate (#1155, FR-001/FR-002). A non-zero exit is a phase
    //    failure regardless of candidate; a missing/invalid candidate is a
    //    no-verdict round even on exit 0 (Q1-A). In either case persist NOTHING
    //    (Q3-A): any prior-round engine artifact — incl. `round` and
    //    `remediationCount` — is left exactly as-is, so `round` does not advance
    //    and repeated failures cannot burn the #1128 remediate cap.
    if (exitCode !== 0 || findings === null) {
      this.logger.warn(
        { exitCode, round, hasCandidate: findings !== null, workflowId },
        'Review phase failed — no fresh verdict; persisting nothing',
      );
      return {
        phase: 'review',
        success: false,
        exitCode: exitCode ?? -1,
        durationMs: Date.now() - startedAt,
        output: outputCapture.getOutput(),
      };
    }

    // 9. Success: exit 0 AND a fresh candidate this round (possibly `[]`).
    //    Compute the verdict from the findings — ignore any agent claim (FR-007).
    const verdict = computeVerdict(findings, blockingSeverity);

    // 10. Stamp the commit reviewed.
    const lastReviewedCommitSha = await context.github.getCurrentCommitSha();

    // 11. Persist the engine-authoritative artifact atomically (round advances).
    //     Carry forward #1128's `remediationCount` and #1156's
    //     `markedReadyByEngine` — the review executor rewrites the artifact each
    //     round, and dropping either field here would silently reset the
    //     review↔remediate cap / the cross-run ready flag on every re-review pass.
    await writeReviewArtifact(checkoutPath, workflowId, {
      findings,
      verdict,
      round,
      lastReviewedCommitSha,
      remediationCount: priorRound?.remediationCount ?? 0,
      markedReadyByEngine: priorRound?.markedReadyByEngine ?? false,
    });

    // 12. Clear the candidate so it cannot be re-ingested on a later round.
    await clearReviewCandidate(checkoutPath, workflowId);

    this.logger.info(
      { verdict, round, findingCount: findings.length, exitCode, lastReviewedCommitSha },
      'Review phase complete — verdict computed by engine',
    );

    return {
      phase: 'review',
      success: true,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: outputCapture.getOutput(),
    };
  }

  /**
   * #1131 (FR-011): true when the resolution diff window has no file changes.
   * Runs `git diff --name-only <baseSha>..<headSha>` in the checkout. On any git
   * failure we conservatively treat the window as non-empty (review runs) rather
   * than silently skipping a review we couldn't prove was empty.
   */
  private async isEmptyWindow(
    checkoutPath: string,
    scope: { baseSha: string; headSha: string },
  ): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', `${scope.baseSha}..${scope.headSha}`],
        { cwd: checkoutPath },
      );
      return stdout.trim() === '';
    } catch (error) {
      this.logger.warn(
        { error: String(error), baseSha: scope.baseSha, headSha: scope.headSha },
        'Could not compute resolution diff window — proceeding with review',
      );
      return false;
    }
  }
}
