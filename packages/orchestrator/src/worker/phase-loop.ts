import type { WorkerContext, PhaseResult, Logger, WorkflowPhase, JobEventEmitter, PhaseAfterHandler, StageType, CommandExitEvidence } from './types.js';
import { PHASE_SEQUENCE, PHASE_TO_STAGE } from './types.js';
import { isTerminalLabelOpError, type TerminalLabelOpSite } from './terminal-label-op-error.js';
import { evaluatePushGuard, type PushGuardDecision } from './push-guard.js';
import { defaultRemoteBranchExists } from './repo-checkout.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { WorkerConfig } from './config.js';
import { resolvePhaseTimeoutMs, resolveAgentForPhase, resolveWorkflowOverrides, DEFAULT_VALIDATE_COMMAND } from './config.js';
import type { ReviewExecutorLike } from './review-executor.js';
import type { RemediateExecutor } from './remediate-executor.js';
import { readReviewArtifactSync, readReviewArtifact, writeReviewArtifact, resetRemediationCount, seedRemediationCount, deriveFindingId, computeVerdict, type ReviewFinding, type ReviewArtifact, type Severity } from './review-artifact.js';
import { waitForCiGreen } from './ci-merge-readiness.js';
import { evaluateTasksMd, type TasksMdEvaluation } from './tasks-md-fallback.js';
import type { LabelManager } from './label-manager.js';
import type { StageCommentManager } from './stage-comment-manager.js';
import type { GateChecker } from './gate-checker.js';
import type { CliSpawner } from './cli-spawner.js';
import { DEFAULT_INSTALL_TIMEOUT_MS, DEFAULT_VALIDATE_TIMEOUT_MS } from './cli-spawner.js';
import type { OutputCapture } from './output-capture.js';
import type { PrManager } from './pr-manager.js';
import type { ReviewPoster } from './review-poster.js';
import type { ConversationLogger } from './conversation-logger.js';
import { postClarifications, hasPendingClarifications, integrateClarificationAnswers } from './clarification-poster.js';
import { PENDING_ANSWER_LITERAL, wrapUntrustedData } from '@generacy-ai/workflow-engine';
import { buildSiblingPromptBlock } from './sibling-prompt.js';
import { checkSiblingReviews } from './sibling-review-checker.js';
import { EXCLUDED_PATH_PREFIXES, EXCLUDED_EXACT_PATHS, computePhaseScopedProductDiff, resolveBaseRef } from './product-diff.js';
import type { PhaseTracker } from '../types/index.js';
import { boundOutputTail } from './output-tail.js';
import { synthesizeOutputTail } from './output-tail-synthesis.js';
import { performBaseMerge, resolveBaseBranch, type BaseMergeRunner } from './base-merge.js';
import { MERGE_CONFLICT_REMEDY } from './merge-conflict-remedy.js';
import { writePauseContext } from './pause-context.js';
import { computeFailureFingerprint, REPEAT_FAILURE_THRESHOLD } from './failure-fingerprint.js';
import { hashValidationEvidence } from './evidence-hash.js';
import type { FailureFingerprintTracker } from '../services/failure-fingerprint-tracker.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyDiff, isTestFile, type Classification } from './diff-classifier.js';
import { runFailThenPass } from './fail-then-pass.js';

const execFileAsync = promisify(execFile);

/** Phases that MUST produce file changes to be considered successful. */
const PHASES_REQUIRING_CHANGES: ReadonlySet<WorkflowPhase> = new Set(['implement']);

/**
 * #1154 FR-005: hidden marker prepended to the "Remediation limit reached" gate
 * body. A resume that re-parks the same cap would otherwise post a duplicate
 * comment on every cycle. Before posting we grep existing PR comment bodies for
 * this marker and skip the post when present (same pattern as
 * `maybePostUntrustedNotice`).
 */
const REMEDIATION_LIMIT_MARKER = '<!-- generacy-remediation-limit -->';
/** Hidden dedupe marker for the `waiting-for:ci` pause comment. */
export const CI_PAUSE_MARKER = '<!-- generacy-ci-pause -->';
/** Prefix of the per-pause fingerprint line: `<!-- generacy-ci-pause verdict=<v> sha=<sha> -->`. */
const CI_PAUSE_MARKER_PREFIX = '<!-- generacy-ci-pause';

/**
 * #1134 (US2): outcome of the speckit-bugfix targeted-validate classification.
 * Carries the resolved effective command plus the raw inputs (`baseRef`,
 * `changedFiles`, `classification`) so the US3 fail-then-pass check can reuse
 * them without re-resolving the base ref or re-fetching the diff.
 */
interface TargetedValidateDecision {
  /** The command that validate should actually run. */
  effectiveCommand: string;
  /** `origin/<base>` — the ref the diff was computed against. */
  baseRef: string;
  /** Bare base branch name (`origin/` stripped). */
  base: string;
  /** Changed-file paths against `baseRef`. */
  changedFiles: string[];
  /** The diff classification. */
  classification: Classification;
}

/**
 * TTL for the persisted phase-start commit ref (#1107). 7 days — longer than
 * the 24h dedup default — so the window survives long gate pauses / fixer
 * timeouts. Expiry degrades to a re-captured (post-resume) window, never to a
 * silent pass.
 */
const PHASE_START_REF_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Type-guard for a git commit SHA. Accepts full (40-hex) or short (7-40 hex)
 * shapes — matches what `git rev-parse HEAD` and short-SHA callers produce.
 * Load-bearing at both persisted-read and fresh-capture sites: an empty or
 * malformed ref silently inverts the phase-scoped product-diff guard, so both
 * paths must reject non-SHA values rather than proceed.
 */
function isValidCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value);
}

/** Narrow a `WorkflowPhase | string` union to WorkflowPhase. */
function isWorkflowPhase(value: WorkflowPhase | string): value is WorkflowPhase {
  return (PHASE_SEQUENCE as readonly string[]).includes(value);
}

/**
 * Dependencies injected into the PhaseLoop.
 */
export interface PhaseLoopDeps {
  labelManager: LabelManager;
  stageCommentManager: StageCommentManager;
  gateChecker: GateChecker;
  cliSpawner: CliSpawner;
  outputCapture: OutputCapture;
  prManager: PrManager;
  conversationLogger?: ConversationLogger;
  /** Optional callback for emitting job lifecycle events */
  jobEventEmitter?: JobEventEmitter;
  /** Optional callbacks invoked after each phase completes, before gate check */
  phaseAfterHandlers?: PhaseAfterHandler[];
  /**
   * Injected base-merge runner used by the pre-phase base-merge hook (#864).
   * Defaults to `performBaseMerge` from `./base-merge.js`. Tests inject a fake
   * that returns canned `BaseMergeResult` values without exercising real git.
   */
  baseMergeRunner?: BaseMergeRunner;
  /**
   * #942: Optional repeat-failure history tracker. When absent, escalation
   * degrades to a no-op (occurrence is always 1, `-repeated` never fires).
   * Injected by the worker-mode wiring in server.ts.
   */
  failureFingerprintTracker?: FailureFingerprintTracker;
  /**
   * #1107: Redis-backed phase tracker used by the implement-phase product-diff
   * guard to persist the phase-start commit ref across increments. Optional —
   * when absent, the guard falls back to a per-invocation `getCurrentCommitSha`
   * capture (post-resume-only window). Injected by the worker-mode wiring in
   * server.ts.
   */
  phaseTracker?: PhaseTracker;
  /**
   * #1121: Off-sequence `remediate` trigger. When it returns true after a
   * successful `review` phase, the loop runs `remediate` (off-sequence) and
   * re-enters `review`. When left at its `undefined` default the seam is inert;
   * a concrete verdict-driven trigger is wired in production via
   * `claude-cli-worker.ts`. The unit test injects a fire-once-then-false
   * predicate to exercise the seam.
   */
  remediateTrigger?: (context: WorkerContext) => boolean;
  /**
   * #1125: posts one COMMENT review per round + resolves threads on re-review.
   * Constructed by the worker wiring (claude-cli-worker) from the PR
   * owner/repo/number. Absent in most unit tests — the review side-effect block
   * only runs when BOTH `reviewPoster` and `readFindingsArtifact` are present.
   */
  reviewPoster?: ReviewPoster;
  /**
   * #1125/#1156/#1161: injectable seam to read the review executor's findings
   * artifact. Returns the canonical `ReviewArtifact` paired with the resolved
   * `blockingSeverity` (used for the poster's render projection). `round` lives
   * only in `artifact.round` (single-round-source, INV-C1/FR-006 — the loop-local
   * counter resets each run and would dedupe-skip re-review after a pause).
   * Defaults undefined → the review side-effect block never runs →
   * production-inert.
   */
  readFindingsArtifact?: (
    context: WorkerContext,
  ) => Promise<{ artifact: ReviewArtifact; blockingSeverity: Severity } | null>;
  /**
   * #1124: Real review-phase executor. When injected, the `review` branch runs
   * it (spawns the CLI with an in-process charter, writes a findings sidecar,
   * and recomputes the verdict engine-side). Absent → the loop falls back to the
   * #1121 inert stub.
   */
  reviewExecutor?: ReviewExecutorLike;
  /**
   * #1128: Real remediate-phase executor. When injected, the off-sequence
   * `remediate` seam runs it (spawns the CLI with the remediation charter and
   * bumps `remediationCount`). Absent → the seam falls back to the #1121 inert
   * stub.
   */
  remediateExecutor?: RemediateExecutor;
  /**
   * #1124: Resolved orchestrator settings, threaded so the review gate can read
   * per-workflow `maxRemediations`. Optional — the `on-remediation-limit` gate
   * falls back to the built-in per-workflow default when absent.
   */
  settings?: OrchestratorSettings | null;
  /**
   * #1187: tasks.md safety-net evaluator. When the implement phase succeeds
   * without emitting a `SPECKIT_IMPLEMENT_PARTIAL` sentinel
   * (`implementResult === undefined`), the loop calls this to decide whether
   * unchecked tasks remain and a partial `implementResult` should be
   * synthesized to re-enter implement. Defaults to the FS-backed
   * {@link evaluateTasksMd}; injectable for tests.
   */
  evaluateTasksMd?: (context: WorkerContext) => TasksMdEvaluation;
}

/**
 * Discriminator for `PhaseLoopResult` (#889 additive extension).
 *
 * - `'completed'`: legacy shape (`completed: true`).
 * - `'gate-hit'`: legacy shape (`gateHit: true`).
 * - `'phase-failed'`: legacy shape (a phase produced `!result.success`).
 * - `'failed-terminal'`: NEW in #889 — a `LabelManager` retry exhausted and
 *   raised `TerminalLabelOpError`. `failureMetadata` carries the alert payload.
 */
export type PhaseLoopStatus = 'completed' | 'gate-hit' | 'phase-failed' | 'failed-terminal';

/**
 * Result of a complete phase loop execution.
 */
export interface PhaseLoopResult {
  /** All phase results from the loop */
  results: PhaseResult[];
  /** Whether the entire loop completed successfully */
  completed: boolean;
  /** The last phase that was executed */
  lastPhase: string;
  /** Whether the loop was stopped by a gate */
  gateHit: boolean;
  /**
   * #889 additive discriminator. Backwards-compatible with existing readers
   * of `completed` / `gateHit` / `lastPhase`.
   */
  status?: PhaseLoopStatus;
  /**
   * Only populated when `status === 'failed-terminal'` (#889). Copied from the
   * thrown `TerminalLabelOpError` and forwarded to the dispatcher.
   */
  failureMetadata?: {
    site: TerminalLabelOpSite;
    labelOp: string;
    ghStderr: string;
  };
}

/**
 * Iterates through workflow phases from the starting phase to completion.
 *
 * For each phase the loop:
 * 1. Updates labels to reflect the current phase
 * 2. Spawns the Claude CLI (or runs the validate command)
 * 3. Marks the phase as completed
 * 4. Checks for review gates
 * 5. Updates the stage comment with progress
 *
 * The loop stops on:
 * - Gate hit (workflow paused for human review)
 * - Phase failure (error)
 * - Abort signal
 * - All phases completed
 */
export class PhaseLoop {
  constructor(private readonly logger: Logger) {}

  /**
   * Execute the phase loop from the starting phase through to completion.
   *
   * @param phaseSequence - Optional workflow-specific phase sequence.
   *   Defaults to the global PHASE_SEQUENCE for backward compatibility.
   */
  async executeLoop(
    context: WorkerContext,
    config: WorkerConfig,
    deps: PhaseLoopDeps,
    phaseSequence?: WorkflowPhase[],
  ): Promise<PhaseLoopResult> {
    try {
      return await this.executeLoopInner(context, config, deps, phaseSequence);
    } catch (error) {
      // #889: LabelManager retry exhaustion. Translate the terminal error into
      // a `failed-terminal` PhaseLoopResult so the worker can surface a bounded
      // alert instead of re-throwing and crash-looping the queue.
      if (isTerminalLabelOpError(error)) {
        this.logger.error(
          {
            site: error.site,
            labelOp: error.labelOp,
            ghStderr: error.ghStderr,
          },
          'Phase loop caught TerminalLabelOpError — surfacing as failed-terminal',
        );
        return {
          results: [],
          completed: false,
          lastPhase: context.startPhase,
          gateHit: false,
          status: 'failed-terminal',
          failureMetadata: {
            site: error.site,
            labelOp: error.labelOp,
            ghStderr: error.ghStderr,
          },
        };
      }
      throw error;
    }
  }

  private async executeLoopInner(
    context: WorkerContext,
    config: WorkerConfig,
    deps: PhaseLoopDeps,
    phaseSequence?: WorkflowPhase[],
  ): Promise<PhaseLoopResult> {
    // #1121 review feedback: derive the effective sequence from the flag so
    // `review` is absent entirely (not merely skipped) when disabled. A
    // skipped-but-present phase still leaks a spurious `review` row into
    // buildPhaseProgress and shifts the resume startIndex, breaking the flag-OFF
    // byte-identical guarantee (Q1=A / SC-004 / FR-009). Filtering here — in
    // addition to getPhaseSequence at the call site — keeps the loop correct
    // even when a caller passes the full sequence explicitly.
    const providedSequence = phaseSequence ?? PHASE_SEQUENCE;
    const sequence = config.reviewPhaseEnabled
      ? providedSequence
      : providedSequence.filter((phase) => phase !== 'review');
    const { labelManager, stageCommentManager, gateChecker, cliSpawner, outputCapture, prManager, conversationLogger, jobEventEmitter } = deps;
    const baseMergeRunner: BaseMergeRunner = deps.baseMergeRunner ?? performBaseMerge;
    const results: PhaseResult[] = [];

    // Mint a stable per-invocation runId used inside the failure-alert marker.
    // See specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md.
    const runId = randomUUID();

    // Track session ID across phases for conversation resume.
    // When a CLI phase completes, its session ID is passed to the next phase
    // so Claude CLI can reuse the conversation (keeping MCP servers warm and
    // carrying forward accumulated context).
    let currentSessionId: string | undefined;
    // #814: track the resolved provider + model across phases. `currentProvider`
    // gates the session-drop-on-provider-switch behavior (FR-011); `currentModel`
    // feeds the `agent.model.transition` log line on same-provider model change.
    let currentProvider: string | undefined;
    let currentModel: string | undefined;
    let implementRetryCount = 0;

    // #1129/#1158: block-local one-shot flag for a validate-origin remediation.
    // When a failing `validate` routes into the review→remediate loop, it
    // synthesizes a changes-required artifact (the sole hand-off to the
    // remediate executor) and sets this flag. The review branch reads it to
    // stub the convergence pass (preserving the synthesized finding); the
    // remediate seam clears it after the executor runs so the following review
    // re-entry runs the real executor to verify the fix. Not persisted.
    let pendingValidateRemediation = false;

    // #1165 Corner 1 (T004): block-local one-shot guard for the flag-OFF
    // validate-fix fallback. When `reviewPhaseEnabled` is off (the default), a
    // failing `validate` gets exactly one bounded remediate attempt before
    // escalating (D1=A / FR-001). Set true when the fallback fires; on the
    // re-run `validate` a second failure sees this true and falls through to
    // the pre-existing escalation. Not persisted (INV-1).
    let flagOffValidateFixAttempted = false;

    // Track last seen tasks_remaining for the implement increment guard.
    // Prevents infinite loops when no progress is made between increments.
    let lastTasksRemaining: number | undefined;

    // Find the starting index in the phase sequence
    const startIndex = sequence.indexOf(context.startPhase);
    if (startIndex === -1) {
      throw new Error(`Unknown starting phase: ${context.startPhase}`);
    }

    this.logger.info(
      { startPhase: context.startPhase, startIndex, totalPhases: sequence.length, runId },
      'Starting phase loop',
    );

    // #1133 FR-006 / research Decision 5: terminal no-op resume. When the
    // CI-aware merge gate is on, the relocated `implementation-review` gate
    // fires on `validate` (the terminal phase) and its GATE_MAPPING resumes
    // at `validate`. A `continue` re-entry that already carries both
    // `completed:validate` and `completed:implementation-review` therefore has
    // nothing left to run — re-executing `validate` would be wrong. Short-
    // circuit to a completed result instead of adding a synthetic terminal
    // WorkflowPhase member (which would ripple across every exhaustive phase
    // enum/union/Record site). Flag-OFF never reaches this branch (SC-006).
    if (
      config.ciMergeGateEnabled
      && context.startPhase === 'validate'
      && context.item.command === 'continue'
    ) {
      const resumeIssue = await context.github.getIssue(
        context.item.owner,
        context.item.repo,
        context.item.issueNumber,
      );
      const resumeLabels = resumeIssue.labels.map((l) => (typeof l === 'string' ? l : l.name));
      if (
        resumeLabels.includes('completed:validate')
        && resumeLabels.includes('completed:implementation-review')
      ) {
        this.logger.info(
          { startPhase: context.startPhase, runId },
          '#1133: implementation-review gate already satisfied — terminal no-op resume, skipping phase loop',
        );
        await this.clearRemediationBudgetMirror(context, deps);
        return { results, completed: true, lastPhase: 'validate', gateHit: false };
      }
    }

    // #1051 FR-002/003: phase-start pre-push guard. Closes the "hasChanges:
    // false no-op hole" (research R3, Q5 clarification) — pr-manager's guard
    // only fires when there is something to push, so a re-entering worker on
    // a merged-then-resurrected checkout that produces no diff could still
    // silently proceed. Running the guard once at loop entry catches that
    // case with a single `event: 'push-refused'` log line and the FR-003b
    // label state, matching the pr-feedback-handler / pr-manager semantics.
    // context.branch is typed optional at the WorkerContext boundary but is
    // populated by claude-cli-worker before phase-loop is entered. Skip the
    // guard entirely if it is somehow unset — the pre-push guards in
    // pr-manager and pr-feedback-handler still fire as backstops.
    if (context.branch) {
      const startGuardDecision = await evaluatePushGuard({
        owner: context.item.owner,
        repo: context.item.repo,
        issueNumber: context.item.issueNumber,
        branch: context.branch,
        github: context.github,
        git: { remoteBranchExists: (b) => defaultRemoteBranchExists(b, context.checkoutPath) },
      });
      if (startGuardDecision.kind === 'refuse') {
        await this.handlePhaseLoopPushRefused(context, startGuardDecision);
        return { results, completed: false, lastPhase: context.startPhase, gateHit: false };
      }
    }

    // Track actual timestamps per phase
    const phaseTimestamps = new Map<WorkflowPhase, { startedAt: string; completedAt?: string }>();

    for (let i = startIndex; i < sequence.length; i++) {
      const phase = sequence[i]!;

      // #1121: `review` is gated out of `sequence` entirely when
      // reviewPhaseEnabled is false (see the effective-sequence derivation
      // above), so a disabled `review` never reaches this loop body — no
      // per-iteration skip guard is needed.

      // #914: per-iteration guard enforcing at-most-one pre-phase base-merge
      // per cycle. Block-scoped `let` inside the for-body is load-bearing —
      // it re-initializes on every iteration (including retry re-entries via
      // `i--; continue;`), keeping the retry semantics of Q3-A intact.
      let hasBaseMergedThisCycle = false;

      // Check abort signal before starting each phase
      if (context.signal.aborted) {
        this.logger.warn({ phase }, 'Abort signal detected, stopping phase loop');
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      this.logger.info({ phase, index: i }, 'Starting phase');

      // Emit job:phase_changed before any label/comment updates
      jobEventEmitter?.('job:phase_changed', {
        jobId: context.jobId,
        workflowName: context.item.workflowName,
        owner: context.item.owner,
        repo: context.item.repo,
        issueNumber: context.item.issueNumber,
        status: 'active',
        currentStep: phase,
      });

      // Record phase start time (only on first entry — preserve across retries for total wall-clock time)
      if (!phaseTimestamps.has(phase)) {
        phaseTimestamps.set(phase, { startedAt: new Date().toISOString() });
      }

      // 1. Update labels: mark this phase as active
      await labelManager.onPhaseStart(phase);

      // 2. Update stage comment to show phase in progress
      const stage = PHASE_TO_STAGE[phase];
      await stageCommentManager.updateStageComment({
        stage,
        status: 'in_progress',
        phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps),
        startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      });

      // 2b. Pre-phase base-merge (#864) — implement, pre-validate, validate only.
      // On {ok:false} the workflow pauses with the merge-conflict gate; on {ok:true}
      // execution proceeds normally. Non-conflict git failures throw and are caught
      // in the same try/catch as phase execution below.
      //
      // #914: the `hasBaseMergedThisCycle` guard enforces the at-most-once
      // invariant. Symmetry immunization per Q5-B — even the implement path,
      // which historically never double-merged, is wrapped so a future edit
      // cannot reintroduce the buggy shape by accident.
      if (phase === 'implement' && !hasBaseMergedThisCycle) {
        const baseMergeOutcome = await this.runPreImplementBaseMerge(
          context,
          deps,
          baseMergeRunner,
          phase,
          stage,
          sequence,
          startIndex,
          i,
          phaseTimestamps,
        );
        if (baseMergeOutcome !== undefined) {
          return baseMergeOutcome;
        }
        hasBaseMergedThisCycle = true;
      }

      // 2c. #1107: capture the phase-start commit ref for the phase-scoped
      // product-diff guard. Must run AFTER the pre-phase base merge (so
      // merged-in base files are never inside startRef..HEAD) and BEFORE the
      // CLI spawn (so HEAD is still the pre-work commit). The ref is persisted
      // once per phase (persist-once → spans all pre-restart increments, Q5);
      // resumes reuse the first-entry ref. Only phases that require product
      // changes need it. Left as `undefined` on any failure — the guard's
      // try/catch then routes to the product-diff-error detection path (SC-005).
      //
      // Key includes the current branch name so a re-entry on a different
      // spec-slug branch (e.g. after a duplicate-PR-on-re-entry recovery)
      // captures a fresh ref instead of reusing a stale one that would span
      // unrelated develop merges — silently fail-open, the exact hazard #1107
      // set out to close. Falls back to a `no-branch` sentinel only when the
      // context branch is unknown, still scoping distinctly from a branch-known
      // key.
      let phaseStartRef: string | undefined;
      const phaseStartRefBranch = context.branch ?? 'no-branch';
      const requiresChanges = PHASES_REQUIRING_CHANGES.has(phase);
      const phaseStartRefKey = requiresChanges
        ? `phase-start-ref:${context.item.owner}:${context.item.repo}:${context.item.issueNumber}:${phaseStartRefBranch}:${phase}`
        : undefined;
      // Legacy (pre-#1110) key omits the branch component. Refs written by the
      // pre-#1110 build are never read by the branch-scoped key and would linger
      // to their 7-day TTL, so on a branch-scoped miss we read through to the
      // legacy key once, migrate a valid value, then consume it (#1112 FR-001/2).
      const legacyPhaseStartRefKey = requiresChanges
        ? `phase-start-ref:${context.item.owner}:${context.item.repo}:${context.item.issueNumber}:${phase}`
        : undefined;
      if (phaseStartRefKey !== undefined) {
        try {
          const rawExisting = await deps.phaseTracker?.getValueRaw(phaseStartRefKey);
          // Reject empty / whitespace / non-SHA-shaped persisted values. An
          // empty string would silently invert the guard: `git log <empty>..HEAD`
          // parses as `HEAD..HEAD` → empty file list → a legitimate implement
          // phase that wrote real code is reported as `no product-code changes`.
          let existing = isValidCommitSha(rawExisting) ? rawExisting : null;

          // FR-001/FR-002: lazy legacy read-through on a branch-scoped miss.
          if (existing === null && legacyPhaseStartRefKey !== undefined) {
            const rawLegacy = await deps.phaseTracker?.getValueRaw(legacyPhaseStartRefKey);
            if (rawLegacy != null) {
              const legacyValid = isValidCommitSha(rawLegacy) ? rawLegacy : null;
              if (legacyValid !== null) {
                // Q1=A: re-persist under the branch-scoped key BEFORE clearing legacy.
                await deps.phaseTracker?.setValueRaw(
                  phaseStartRefKey, legacyValid, PHASE_START_REF_TTL_SECONDS,
                );
                existing = legacyValid;
                this.logger.info(
                  { phase },
                  'migrated legacy phase-start-ref to branch-scoped key',
                );
              } else {
                this.logger.warn(
                  { phase },
                  'legacy phase-start-ref failed SHA-shape check — discarding',
                );
              }
              // Q3=A: consume-once — clear on ANY legacy read (accepted or
              // rejected), after the branch write. Post-#1110 nothing re-creates
              // the unbranched key, so a rejected value can never become valid.
              await deps.phaseTracker?.clearRaw(legacyPhaseStartRefKey);
            }
          }

          // FR-003/FR-004: a shape-valid ref may still not resolve in this
          // checkout (e.g. an unpushed base-merge commit after re-entry on a
          // fresh clone). Verify a reused ref before anchoring the diff window;
          // commit-missing → treat as absent and re-capture. A non-commit-missing
          // git fault throws → caught below → phaseStartRef undefined →
          // product-diff-error (FR-005, preserved for free).
          if (existing !== null && !(await context.github.commitExistsInCheckout(existing))) {
            this.logger.warn(
              { phase, ref: existing },
              'persisted phase-start-ref does not resolve in this checkout — re-capturing',
            );
            existing = null;
          }

          if (existing === null) {
            const captured = await context.github.getCurrentCommitSha();
            if (!isValidCommitSha(captured)) {
              throw new Error(
                `getCurrentCommitSha returned a non-SHA value: ${JSON.stringify(captured)}`,
              );
            }
            phaseStartRef = captured;
            await deps.phaseTracker?.setValueRaw(phaseStartRefKey, phaseStartRef, PHASE_START_REF_TTL_SECONDS);
          } else {
            phaseStartRef = existing;
          }
        } catch (err) {
          this.logger.warn(
            { phase, err: String(err) },
            'phase-start-ref capture failed — guard will treat as detection failure',
          );
        }
      }

      // 3. Execute the phase
      let result: PhaseResult;
      // #1158 T012: hoisted to per-iteration scope so the validate failure-routing
      // block below (~:990) can cite the effective (possibly targeted) command in
      // the fingerprint reason + synthesized finding. No shadow re-declaration.
      // #1160 (FR-001/FR-002): seed from the per-workflow resolution so a
      // `workflows.<name>.validateCommand` override reaches the spawn (this falls
      // back to the flat `config.validateCommand`). The speckit-bugfix branch below
      // overwrites this with the targeted-validate decision, which itself resolves
      // per-workflow — so FR-002 (targeted narrowing composing over the resolved
      // base) holds by construction.
      let effectiveValidateCommand = resolveWorkflowOverrides(
        config,
        deps.settings ?? null,
        context.item.workflowName,
      ).validateCommand;
      try {
        if (phase === 'review') {
          if (pendingValidateRemediation) {
            // #1129: validate-origin backtrack. The synthesized artifact is
            // already changes-required for this round, so skip both the
            // convergence scaffolding and the real executor — running either
            // would overwrite the synthesized finding or re-scope prematurely.
            // A synthetic success leaves the artifact intact for the
            // `on-remediation-limit` gate + the remediateTrigger seam below.
            result = this.runStubPhase('review');
          } else {
            // #1124 + #1161: real review executor when injected — spawns the CLI
            // with an in-process charter, has the agent write a findings sidecar,
            // and runs the #1126 delta-scoped convergence merge end-to-end
            // (round-N→N+1 carry-forward + verdict) INSIDE the executor. The old
            // `runReviewConvergence` pre-pass is deleted: round now lives only in
            // the sidecar (single-round-source, INV-C1/FR-006). Falls back to the
            // #1121 inert stub when no executor is wired (feature-flag-off /
            // non-worker paths).
            result = deps.reviewExecutor
              ? await deps.reviewExecutor.execute(context)
              : this.runStubPhase(phase);
          }
        } else if (phase === 'remediate') {
          // #1121: inert stub executor. Real remediate logic lands in a later
          // epic issue. Returns a synthetic success without spawning the CLI.
          result = this.runStubPhase(phase);
        } else if (phase === 'validate') {
          // 3a. Pre-phase base-merge for the validate cycle (#864, #914) —
          // ephemeral. Runs ONCE before the first spawned command of the
          // cycle (install, or validate itself if no preValidateCommand).
          // The second between-install-and-validate call site (#864 original)
          // was deleted in #914 — its `git reset --hard` + `git clean -fd`
          // was destroying the freshly-installed toolchain (snappoll#4).
          if (!hasBaseMergedThisCycle) {
            const preValidateMergeOutcome = await this.runPreValidateBaseMerge(
              context,
              deps,
              baseMergeRunner,
              phase,
              stage,
              sequence,
              startIndex,
              i,
              phaseTimestamps,
            );
            if (preValidateMergeOutcome !== undefined) {
              return preValidateMergeOutcome;
            }
            hasBaseMergedThisCycle = true;
          }

          // Pre-validate: install dependencies if configured.
          // #1160 (FR-003/FR-004): resolve per-workflow so a
          // `workflows.<name>.preValidateCommand` override reaches the install
          // step. `??` preserves an explicit `""` (skip) vs unset (cluster default);
          // the `if (cmd)` truthiness guard below already skips on empty-string.
          const effectivePreValidateCommand = resolveWorkflowOverrides(
            config,
            deps.settings ?? null,
            context.item.workflowName,
          ).preValidateCommand;
          if (effectivePreValidateCommand) {
            const installResult = await cliSpawner.runPreValidateInstall(
              context.checkoutPath,
              effectivePreValidateCommand,
              context.signal,
            );
            if (!installResult.success) {
              this.logger.error(
                { phase, error: installResult.error?.message },
                'Pre-validate install failed',
              );
              results.push(installResult);
              const evidence = this.buildErrorEvidence(
                effectivePreValidateCommand,
                installResult,
                DEFAULT_INSTALL_TIMEOUT_MS,
                undefined,
              );
              await stageCommentManager.updateStageComment({
                stage,
                status: 'error',
                phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
                startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
                errorEvidence: evidence,
              });
              await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
              return { results, completed: false, lastPhase: phase, gateHit: false };
            }
          }

          // Validate phase — run test command.
          // #1134 (US2): for speckit-bugfix, classify the diff and narrow the
          // built-in default validate command to a pnpm workspace-filter form.
          // Every other workflow reaches the plain default unchanged (SC-005).
          // #1158 T012 / #1160: `effectiveValidateCommand` is hoisted to the
          // iteration scope above (seeded from the per-workflow resolution);
          // assign (not re-declare) the targeted narrowing here.
          let targetedValidate: TargetedValidateDecision | undefined;
          if (context.item.workflowName === 'speckit-bugfix') {
            targetedValidate = await this.resolveTargetedValidate(
              context,
              prManager,
              config,
              deps.settings ?? null,
            );
            effectiveValidateCommand = targetedValidate.effectiveCommand;
          }

          // #1134 (US3): opt-in fail-then-pass regression proof. Off by default;
          // when enabled for speckit-bugfix, verify the changed test files fail
          // on the base ref and pass on the branch before running validate.
          let validateResult: PhaseResult | undefined;
          if (
            targetedValidate &&
            resolveWorkflowOverrides(config, deps.settings ?? null, context.item.workflowName).review
              .failThenPass
          ) {
            validateResult = await this.runFailThenPassCheck(context, targetedValidate);
          }

          result =
            validateResult ??
            (await cliSpawner.runValidatePhase(
              context.checkoutPath,
              effectiveValidateCommand,
              context.signal,
            ));
        } else {
          // Set up conversation logger for this CLI phase
          if (conversationLogger) {
            conversationLogger.setPhase(phase, currentSessionId ?? '', undefined);
          }

          // CLI phase — spawn Claude CLI (resume previous session if available)
          const siblingBlock = buildSiblingPromptBlock(context.siblingWorkdirs ?? {});
          const prompt = siblingBlock
            ? `${siblingBlock}\n\n${context.issueUrl}`
            : context.issueUrl;
          const cliPhase = phase as Exclude<typeof phase, 'validate' | 'review' | 'remediate'>;

          // #814/#1095: resolve provider+model+effort for this phase. Provider always
          // defined (built-in fallback). Model + effort optional (undefined = no
          // `--model` / `--effort` arg pushed at the plugin builder).
          const { provider: nextProvider, model: nextModel, effort: nextEffort } = resolveAgentForPhase(
            config,
            context.item.workflowName,
            cliPhase,
          );

          // Drop session on provider switch (FR-011). Sessions are provider-scoped;
          // reusing one across providers would try to resume against a session ID
          // the new provider doesn't know.
          if (currentProvider !== undefined && currentProvider !== nextProvider) {
            this.logger.info(
              { phase: cliPhase, prevProvider: currentProvider, nextProvider },
              'Provider switch detected — dropping session for fresh start',
            );
            currentSessionId = undefined;
          }

          // Emit model-transition log line on same-provider model change (Q2→C).
          // Only meaningful when we actually saw a prior phase with the same
          // provider AND both models are defined (a switch from undefined→X or
          // X→undefined is not a "transition" — either the config just started
          // or just stopped naming a model).
          if (
            currentProvider === nextProvider &&
            currentModel !== undefined &&
            nextModel !== undefined &&
            currentModel !== nextModel
          ) {
            this.logger.info(
              { provider: nextProvider, prevModel: currentModel, nextModel },
              'agent.model.transition',
            );
          }

          const previousModel = currentProvider === nextProvider ? currentModel : undefined;

          result = await cliSpawner.spawnPhase(
            cliPhase,
            {
              prompt,
              cwd: context.checkoutPath,
              env: { CLAUDE_HEADLESS: 'true' },
              timeoutMs: resolvePhaseTimeoutMs(config, cliPhase),
              signal: context.signal,
              resumeSessionId: currentSessionId,
              siblingWorkdirs: context.siblingWorkdirs,
              provider: nextProvider,
              ...(nextModel !== undefined ? { model: nextModel } : {}),
              ...(nextEffort !== undefined ? { effort: nextEffort } : {}),
              ...(previousModel !== undefined ? { previousModel } : {}),
            },
            outputCapture,
          );

          // Update trackers post-spawn so failures don't strand state.
          currentProvider = nextProvider;
          currentModel = nextModel;
        }
      } catch (error) {
        // Unexpected error during spawning
        this.logger.error(
          { phase, error: String(error) },
          'Unexpected error during phase execution',
        );
        const syntheticResult: PhaseResult = {
          phase,
          success: false,
          exitCode: 1,
          durationMs: 0,
          output: [],
          error: { message: String(error), output: '', phase },
        };
        const evidence = this.buildErrorEvidence(
          phase === 'validate' ? config.validateCommand : phase,
          syntheticResult,
          undefined,
          'spawn-error',
        );
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          errorEvidence: evidence,
        });
        await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
        throw error;
      }

      results.push(result);

      // 3a-bis. Close conversation logger for this phase (flush + phase_complete entry)
      if (conversationLogger && phase !== 'validate') {
        try {
          await conversationLogger.close();
        } catch (err) {
          this.logger.warn(
            { phase, error: String(err) },
            'ConversationLogger.close() failed — continuing',
          );
        }
      }

      // 3b. Capture session ID for resume in subsequent phases
      if (result.sessionId) {
        if (!currentSessionId) {
          this.logger.info({ sessionId: result.sessionId, phase }, 'Captured initial session ID for conversation reuse');
        }
        currentSessionId = result.sessionId;
      }

      // 3b-bis. tasks.md safety net (#1187): the agent finished the implement
      // phase without emitting a `SPECKIT_IMPLEMENT_PARTIAL` sentinel. Parse the
      // workflow's tasks.md and, when unchecked tasks remain, synthesize a
      // partial `implementResult` so the increment block below drives re-entry
      // exactly as the sentinel path would. Fires only when the sentinel is
      // absent, so sentinel-present runs are byte-identical (SC-005).
      if (phase === 'implement' && result.success && result.implementResult === undefined) {
        const evalResult = (deps.evaluateTasksMd ?? evaluateTasksMd)(context);
        if (evalResult.kind === 'incomplete') {
          result.implementResult = {
            partial: true,
            tasks_remaining: evalResult.unchecked,
            tasks_completed: evalResult.checked,
            tasks_total: evalResult.total,
          };
          this.logger.info(
            {
              phase,
              issueNumber: context.item.issueNumber,
              tasksRemaining: evalResult.unchecked,
              tasksTotal: evalResult.total,
            },
            'tasks.md safety net: unchecked tasks remain, re-entering implement',
          );
        } else if (evalResult.kind === 'unreadable') {
          this.logger.info(
            { phase, reason: evalResult.reason, issueNumber: context.item.issueNumber },
            'tasks.md safety net: advancing (fallback source unavailable)',
          );
        }
        // 'complete' → no-op → the increment block below is skipped → advance.
      }

      // 3c. Increment boundary: re-invoke implement with a fresh session if partial
      if (phase === 'implement' && result.success && result.implementResult?.partial) {
        const tasksRemaining = result.implementResult.tasks_remaining ?? 0;

        // Guard: fail if no progress made (prevents infinite loop)
        if (lastTasksRemaining !== undefined && tasksRemaining >= lastTasksRemaining) {
          this.logger.error(
            { phase, tasksRemaining, lastTasksRemaining },
            'Implement increment made no progress — failing to prevent infinite loop',
          );
          // FR-007: set result.error BEFORE evidence derivation so the alert
          // and stage-comment evidence blocks have diagnostic content.
          result.success = false;
          result.error = {
            message: 'Implement increment made no progress — aborting to prevent infinite loop',
            output: `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments`,
            phase,
          };
          const evidence = this.buildErrorEvidence(
            'implement (no-progress guard)',
            result,
            undefined,
            'no-progress',
          );
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }
        lastTasksRemaining = tasksRemaining;

        // Commit, push, and ensure PR with a WIP message
        const partialOutcome = await prManager.commitPushAndEnsurePr(phase, {
          message: `wip(speckit): implement increment for #${context.item.issueNumber} (${result.implementResult.tasks_completed ?? 0} tasks done, ${tasksRemaining} remaining)`,
        });
        if (partialOutcome.pushRefused) {
          this.logger.warn(
            { phase, refusal: partialOutcome.pushRefused },
            'Phase loop aborted at implement increment: pre-push guard refused',
          );
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }
        if (partialOutcome.prUrl) context.prUrl = partialOutcome.prUrl;

        // Clear session for a fresh context window on next increment
        currentSessionId = undefined;

        // Update stage comment with incremental progress
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });

        this.logger.info({ tasksRemaining }, 'Implement increment complete — re-invoking with fresh session');
        i--; // Re-run implement phase
        continue;
      }

      // Reset increment tracking when leaving the implement phase normally
      if (phase !== 'implement') {
        lastTasksRemaining = undefined;
      }

      // 4. Handle phase failure
      if (!result.success) {
        this.logger.error(
          { phase, exitCode: result.exitCode, error: result.error?.message },
          'Phase failed',
        );

        // Implement phase retry: commit partial progress and retry with a fresh session
        if (phase === 'implement') {
          const retryOutcome = await prManager.commitPushAndEnsurePr(phase, {
            message: `wip(speckit): partial implement progress for #${context.item.issueNumber} (retry ${implementRetryCount + 1})`,
          });
          if (retryOutcome.pushRefused) {
            this.logger.warn(
              { phase, refusal: retryOutcome.pushRefused },
              'Phase loop aborted at implement retry: pre-push guard refused',
            );
            return { results, completed: false, lastPhase: phase, gateHit: false };
          }
          if (retryOutcome.hasChanges && implementRetryCount < config.maxImplementRetries) {
            implementRetryCount++;
            currentSessionId = undefined;
            this.logger.warn(
              { phase, retry: implementRetryCount, maxRetries: config.maxImplementRetries },
              'Implement phase failed with partial progress — retrying with fresh session',
            );
            await stageCommentManager.updateStageComment({
              stage,
              status: 'in_progress',
              phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
              startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
              prUrl: context.prUrl,
            });
            i--;
            continue;
          }
        }

        // #1129: route a failing `validate` into the engine-native
        // review→remediate loop, superseding the legacy #892 base-advance
        // one-shot. Guarded on the review flag; the `base-advance` precondition
        // is gone (FR-004). The thin adapter is dispatched only at the remediate
        // seam (T006) — never here — giving structural mutual exclusion (FR-008).
        // Defensive fallback: if no linked PR exists, drop through to the
        // pre-existing escalation rather than routing (contracts Step 3).
        if (phase === 'validate' && config.reviewPhaseEnabled === true) {
          const prNumber = prManager.getPrNumber();
          if (prNumber !== undefined) {
            const validateEvidence = {
              stdout: result.capturedStdout ?? '',
              // #890 renamed `error.stderr` → `error.output` (merged tail);
              // fall back to it when the raw stderr buffer is empty.
              stderr: result.capturedStderr ?? result.error?.output ?? '',
              exitCode: result.exitCode,
            };

            // Fingerprint-first escalation (FR-006 / FR-009). The loop owns
            // escalation now: never apply `failed:validate` (no onError), only
            // post the alert and, at the repeat threshold, the `-repeated`
            // backstop that terminates. Build CommandExitEvidence for the
            // fingerprint + alert (the helpers key on it, not on the raw
            // stdout/stderr/exitCode triple).
            //
            // #1158 T007 (FR-004/FR-005): stamp a STABLE fingerprint reason so
            // `computeFailureFingerprint` (keys on `reason ?? outputTail`) yields
            // the same fingerprint for the same defect across test-output
            // nondeterminism (timings, parallel ordering). The reason pairs the
            // effective (possibly targeted, T013) command with a content hash of
            // the failing-test identifiers.
            const stableReason = `${effectiveValidateCommand} :: ${hashValidationEvidence(validateEvidence.stdout).hash}`;
            const cmdEvidence = this.buildErrorEvidence(
              effectiveValidateCommand,
              result,
              DEFAULT_VALIDATE_TIMEOUT_MS,
              undefined,
              stableReason,
            );
            const fingerprint = computeFailureFingerprint({
              phase: 'validate',
              evidence: cmdEvidence,
            });
            const priorCount = deps.failureFingerprintTracker
              ? await deps.failureFingerprintTracker.countPriorOccurrences(
                  context.item.owner,
                  context.item.repo,
                  context.item.issueNumber,
                  fingerprint,
                )
              : 0;
            const occurrence = priorCount + 1;
            await stageCommentManager.postFailureAlert({
              stage,
              runId,
              phase: 'validate',
              evidence: cmdEvidence,
              fingerprint,
              occurrence,
            });

            if (occurrence >= REPEAT_FAILURE_THRESHOLD) {
              this.logger.warn(
                { phase, fingerprint, occurrence, issue: context.item.issueNumber },
                'Repeat-identical validate failure — escalating with failed:validate-repeated',
              );
              await labelManager.onRepeatedError('validate');
              return { results, completed: false, lastPhase: 'validate', gateHit: false };
            }

            // Synthesize a changes-required review artifact and backtrack into
            // the review phase (contracts Step 2, data-model Entity 1). The
            // real review executor re-scopes on re-entry; the remediate seam
            // consumes `pendingValidateRemediation` and dispatches the adapter.
            const { round } = await this.synthesizeValidateChangesRequiredArtifact(
              context,
              config.validateCommand,
              effectiveValidateCommand,
              validateEvidence,
            );

            // #1158 T014: mark the validate-origin backtrack. The synthesized
            // `changes-required` finding above feeds `RemediateExecutor`'s
            // charter via `readReviewArtifact` at the remediate seam — the
            // former payload (evidence/prNumber/baseBranch) had no consumer once
            // the `ValidateFixHandler` adapter was retired (remediate-seam.md).
            pendingValidateRemediation = true;
            this.logger.info(
              { phase, prNumber, round, occurrence, fingerprint },
              '#1129: routing validate failure into review→remediate loop',
            );
            i = sequence.indexOf('review') - 1;
            continue;
          }
        }

        // #1165 Corner 1 (T004): flag-OFF validate-fix fallback. On the default
        // (reviewPhaseEnabled OFF) path, give a failing `validate` exactly one
        // bounded remediate attempt before escalating (D1=A / FR-001). Mutually
        // exclusive with the flag-ON routing block above by flag value (INV-3):
        // dead when reviewPhaseEnabled === true. See
        // contracts/flag-off-validate-fix.md.
        if (
          phase === 'validate'
          && config.reviewPhaseEnabled !== true
          && flagOffValidateFixAttempted === false
          && deps.remediateExecutor
        ) {
          // INV-1: bind to exactly one attempt. A second validate failure sees
          // this true, skips the fallback, and falls through to escalation.
          flagOffValidateFixAttempted = true;

          const validateEvidence = {
            stdout: result.capturedStdout ?? '',
            // #890 renamed `error.stderr` → `error.output` (merged tail).
            stderr: result.capturedStderr ?? result.error?.output ?? '',
          };
          await this.synthesizeValidateChangesRequiredArtifact(
            context,
            config.validateCommand,
            effectiveValidateCommand,
            validateEvidence,
          );
          this.logger.info(
            { phase, issue: context.item.issueNumber },
            '#1165: flag-OFF validate failure — running one bounded remediate attempt',
          );

          const remediateResult = await deps.remediateExecutor.execute(context);
          // Push-gate identical to the review→remediate seam: push a clean-run
          // zero exit OR a timeout-kill (partial work is worth keeping); a
          // clean-run non-zero exit means the fixer produced no usable changes.
          const shouldPush =
            remediateResult.exitCode === 0 || remediateResult.timedOut === true;
          if (shouldPush) {
            const remediateCommitOutcome = await prManager.commitPushAndEnsurePr('remediate');
            // #1051: a refused push MUST abort the loop.
            if (remediateCommitOutcome.pushRefused) {
              this.logger.warn(
                { phase: 'remediate', refusal: remediateCommitOutcome.pushRefused },
                'Phase loop aborted: pre-push guard refused flag-OFF validate-fix remediate cycle',
              );
              return { results, completed: false, lastPhase: 'remediate', gateHit: false };
            }
            if (remediateCommitOutcome.prUrl) {
              context.prUrl = remediateCommitOutcome.prUrl;
            }
            // #1162 FR-003 mirror: persist the post-bump remediationCount to the
            // durable Redis mirror (best-effort; no-op when Redis is down).
            const { owner, repo, issueNumber } = context.item;
            const workflowId = `${owner}/${repo}#${issueNumber}`;
            const remediationCount = readReviewArtifactSync(
              context.checkoutPath,
              workflowId,
            )?.remediationCount;
            if (remediationCount !== undefined) {
              const branch = context.branch ?? 'no-branch';
              await deps.phaseTracker?.setValueRaw(
                `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`,
                String(remediationCount),
                PHASE_START_REF_TTL_SECONDS,
              );
            }
          } else {
            // INV-2: a non-successful, non-timeout remediate must not land
            // partial work. Revert the working tree (excluding `.generacy` so
            // the review sidecar survives); if the revert throws we cannot
            // guarantee a clean branch, so abort.
            this.logger.warn(
              { phase: 'remediate', exitCode: remediateResult.exitCode },
              '#1165: flag-OFF remediate exited non-zero without a timeout — skipping commit/push (branch untouched)',
            );
            try {
              await context.github.discardWorkingTreeChanges(['.generacy']);
            } catch (error) {
              this.logger.error(
                { phase: 'remediate', error: String(error) },
                '#1165: failed to revert working tree after skipped flag-OFF remediate push — aborting',
              );
              return { results, completed: false, lastPhase: 'remediate', gateHit: false };
            }
          }
          results.push(remediateResult);
          outputCapture.clear();
          i--; // Re-run the validate phase.
          continue;
        }

        const evidence = this.buildErrorEvidence(
          phase === 'validate' ? config.validateCommand : phase,
          result,
          phase === 'validate'
            ? DEFAULT_VALIDATE_TIMEOUT_MS
            : resolvePhaseTimeoutMs(config, phase as Exclude<WorkflowPhase, 'validate'>),
          undefined,
        );
        await stageCommentManager.updateStageComment({
          stage,
          status: 'error',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          errorEvidence: evidence,
        });
        await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 4b. Validate green ⇒ the proof that every validate-origin failure is
      // fixed. Auto-resolve any still-open `synthetic: 'validate'` finding in
      // the review sidecar (counterpart of the failure-path synthesis above) so
      // a stale `changes-required` cannot re-trigger remediate later.
      if (phase === 'validate' && result.success) {
        await this.resolveSyntheticValidateFindings(
          context,
          resolveWorkflowOverrides(config, deps.settings ?? null, context.item.workflowName)
            .review.blockingSeverity,
        );
      }

      // 5. Commit, push, and ensure draft PR exists (before marking complete)
      const commitOutcome = await prManager.commitPushAndEnsurePr(phase);
      const { prUrl, hasChanges } = commitOutcome;
      if (prUrl) {
        context.prUrl = prUrl;
      }

      // #1051 PR #1052 review Finding 3: refusal MUST abort the phase loop.
      // Without this, the guard blocks the push but the loop treats the
      // returned `hasChanges: false` as a legitimate no-op, calls
      // `onPhaseComplete` for the current phase, advances to the next, and
      // eventually flips the PR ready-for-review — with zero commits reaching
      // origin. Mirrors the loop-ENTRY guard's abort at :237-240.
      // handlePushRefused inside pr-manager already emitted the FR-003a log
      // and applied the FR-003b label state, so this branch only owns the
      // control-flow exit.
      if (commitOutcome.pushRefused) {
        this.logger.warn(
          { phase, refusal: commitOutcome.pushRefused },
          'Phase loop aborted: pre-push guard refused this cycle — see prior push-refused log for details',
        );
        return { results, completed: false, lastPhase: phase, gateHit: false };
      }

      // 5b. Fail phases that require product-code changes but produced none.
      // #1107: measures the PHASE'S OWN diff (first-parent, no-merges, since a
      // start ref captured after the pre-phase base merge) rather than the
      // cumulative branch diff, so earlier-phase and base-merge-introduced
      // files never satisfy the guard. Rejects when every changed file lives
      // under EXCLUDED_PATH_PREFIXES or exactly matches EXCLUDED_EXACT_PATHS
      // (the spec-kit update_agent targets). See specs/820-*, specs/1107-*.
      if (PHASES_REQUIRING_CHANGES.has(phase)) {
        let productFiles: string[];
        let changedFiles: string[];
        // Diagnostics-only (Decision 5): the pass/fail decision keys off the
        // phase-scoped diff, not baseRef. Resolve best-effort so a base-ref
        // lookup failure never turns into a false detection failure.
        let baseRef = 'unknown';
        try {
          baseRef = await resolveBaseRef(
            context.github,
            prManager,
            context.item.owner,
            context.item.repo,
          );
        } catch (err) {
          this.logger.warn(
            { phase, err: String(err) },
            'resolveBaseRef failed — continuing with phase-scoped guard (diagnostics only)',
          );
        }
        try {
          if (phaseStartRef === undefined) {
            throw new Error('phase-start ref was not captured before CLI spawn');
          }
          ({ productFiles, changedFiles } = await computePhaseScopedProductDiff(
            context.github,
            phaseStartRef,
          ));
        } catch (err) {
          this.logger.error(
            { phase, err: String(err) },
            'product-diff computation threw — treating as detection failure',
          );
          result.success = false;
          result.error = {
            message: `Phase "${phase}" product-diff detection failed: ${String(err)}`,
            output: '',
            phase,
          };
          const evidence = this.buildErrorEvidence(
            phase === 'validate' ? config.validateCommand : phase,
            result,
            undefined,
            'product-diff-error',
          );
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }

        if (productFiles.length === 0) {
          // FR-004: include the phase-scoped changed files, the start ref used,
          // the resolved base ref for context, and both exclusion sets.
          this.logger.error(
            {
              phase,
              startRef: phaseStartRef,
              baseRef,
              changedFiles,
              excludedPrefixes: EXCLUDED_PATH_PREFIXES,
              excludedExactPaths: EXCLUDED_EXACT_PATHS,
            },
            'implement phase produced no product-code changes — all own-commit diff lives under excluded paths',
          );
          result.success = false;
          result.error = {
            message:
              `Phase "${phase}" produced no product-code changes — every file touched by the phase's own ` +
              `commits (since ${phaseStartRef}) is under an excluded prefix [${EXCLUDED_PATH_PREFIXES.join(', ')}] ` +
              `or is an excluded agent-context file [${EXCLUDED_EXACT_PATHS.join(', ')}]. ` +
              `Own-commit files: [${changedFiles.join(', ')}]. Implement must modify at least one product file.`,
            output: '',
            phase,
          };
          const evidence = this.buildErrorEvidence(
            phase === 'validate' ? config.validateCommand : phase,
            result,
            undefined,
            'no-product-code-changes',
          );
          await stageCommentManager.updateStageComment({
            stage,
            status: 'error',
            phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
            startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
            prUrl: context.prUrl,
            errorEvidence: evidence,
          });
          await this.escalateAndAlert(context, deps, phase, evidence, stage, runId);
          // Failure: leave the start ref (TTL backstop) so a retry still spans
          // the whole phase.
          return { results, completed: false, lastPhase: phase, gateHit: false };
        }

        // Pass: clear the persisted start ref so the next distinct phase entry
        // re-captures. TTL is the backstop if this clear is skipped.
        if (phaseStartRefKey !== undefined) {
          await deps.phaseTracker?.clearRaw(phaseStartRefKey);
        }
      }

      // 5c. #958 FR-009 safety-net + FR-010 parse-failure reporting.
      // Runs unconditionally on the clarify phase (used to sit inside the
      // gate-active branch — went quiet exactly when needed). Integration
      // happens here so the local clarifications.md reflects any freshly
      // relayed answers before the gate check.
      let clarifyIntegration:
        | Awaited<ReturnType<typeof integrateClarificationAnswers>>
        | undefined;
      if (phase === 'clarify') {
        try {
          clarifyIntegration = await integrateClarificationAnswers(context, this.logger);
        } catch (err) {
          this.logger.warn(
            { err: String(err) },
            'integrateClarificationAnswers threw — continuing (gate check will pause on unknown state per FR-007)',
          );
        }
        try {
          await postClarifications(context, this.logger);
        } catch (err) {
          this.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to post clarification questions safety net — continuing',
          );
        }
        // FR-010: surface parse failures on the issue + relay event.
        if (
          clarifyIntegration?.parseFailures !== undefined
          && clarifyIntegration.parseFailures.length > 0
        ) {
          await this.reportClarificationParseFailures(context, clarifyIntegration);
        }
      }

      // 5d. Invoke phase:after handlers (post-commit, pre-gate)
      for (const handler of deps.phaseAfterHandlers ?? []) {
        await handler({ ...context, phase, commitResult: { prUrl, hasChanges } });
      }

      // #1133 US3/FR-004: CI-aware merge readiness. On a successful `validate`
      // with the flag on, mark the PR ready (so repo CI that only triggers on
      // ready_for_review actually runs) and wait for the head-SHA rollup to
      // resolve. `green` → let the relocated `on-ci-green` gate fire below;
      // `not-passed` → readiness is blocked, the gate is NOT raised and the
      // loop completes normally; `timeout` → pause with `waiting-for:ci` +
      // `agent:paused` (short-circuit before the gate loop, never busy-loop —
      // SC-005). Skipped/neutral runs read as pending → they never mark the PR
      // green, so a skipped-only PR times out into the pause (SC-001).
      let ciMergeVerdict: 'green' | 'not-passed' | undefined;
      if (phase === 'validate' && result.success && config.ciMergeGateEnabled) {
        await prManager.markReadyForReview(context.linkedPRs);

        // #1157 FR-005: resolve the head SHA first. If it is unusable (the
        // readout threw, yielded a falsy value, or yielded the `'unknown'`
        // sentinel), fast-fail into the SAME recoverable pause as red CI —
        // BEFORE `waitForCiGreen`, so `getCiRunsForSha` never polls
        // `commits/unknown/check-runs` for the full `ciWaitTimeoutMs`
        // (contracts/ci-pause-behavior.md "Ordering guarantees").
        let headSha: string | undefined;
        try {
          headSha = await context.github.getCurrentCommitSha();
        } catch (err) {
          this.logger.warn(
            { err: String(err), phase },
            '#1133: getCurrentCommitSha failed before CI readiness wait',
          );
        }
        if (!headSha || headSha === 'unknown') {
          this.logger.warn(
            { phase, headSha },
            '#1157 FR-005: unusable head SHA — pausing for CI readiness without polling',
          );
          return await this.pauseForCiReadiness({
            phase,
            reason:
              'Could not resolve the PR head commit SHA; CI merge-readiness cannot be evaluated.',
            ci: { verdict: 'unknown', headSha: 'unknown' },
            context,
            deps,
            results,
            result,
            phaseTimestamps,
            stage,
            sequence,
            startIndex,
            currentIndex: i,
          });
        }

        // #1160 (FR-006): resolve per-workflow so a
        // `workflows.<name>.ciWaitTimeoutMs` override reaches the wait budget.
        const effectiveCiWaitTimeoutMs = resolveWorkflowOverrides(
          config,
          deps.settings ?? null,
          context.item.workflowName,
        ).ciWaitTimeoutMs;
        const outcome = await waitForCiGreen({
          github: context.github,
          owner: context.item.owner,
          repo: context.item.repo,
          headSha,
          branch: context.branch ?? '',
          ciWaitTimeoutMs: effectiveCiWaitTimeoutMs,
          logger: this.logger,
        });
        this.logger.info(
          { phase, outcome: outcome.kind, ciWaitTimeoutMs: effectiveCiWaitTimeoutMs },
          '#1133: CI merge-readiness wait resolved',
        );
        if (outcome.kind === 'timeout') {
          return await this.pauseForCiReadiness({
            phase,
            reason: 'CI did not turn green within the merge-readiness timeout',
            ci: { verdict: outcome.verdict, source: outcome.source, headSha },
            context,
            deps,
            results,
            result,
            phaseTimestamps,
            stage,
            sequence,
            startIndex,
            currentIndex: i,
          });
        }
        // #1157 FR-001/FR-002/FR-003: a red-CI `not-passed` verdict must pause
        // in the same recoverable state — NOT fall through to the gate loop and
        // the step-6b `onPhaseComplete` (which would grant `completed:validate`
        // and let the loop return `completed: true`). Return early here, before
        // the gate loop, so `on-ci-green` never fires and `completed:validate`
        // is never granted (INV-1/INV-2/INV-3).
        if (outcome.kind === 'not-passed') {
          return await this.pauseForCiReadiness({
            phase,
            reason:
              'CI has not passed for the head commit; the merge gate will not open until CI is green.',
            ci: { verdict: outcome.verdict, source: outcome.source, headSha },
            context,
            deps,
            results,
            result,
            phaseTimestamps,
            stage,
            sequence,
            startIndex,
            currentIndex: i,
          });
        }
        ciMergeVerdict = outcome.kind;
      }

      // 6. Check for review gates (multi-gate: iterate all matching gates for this phase)
      const gates = gateChecker.checkGates(phase, context.item.workflowName, config);

      // Fetch current issue labels once (shared across all gate evaluations)
      let currentLabels: string[] | undefined;

      for (const gate of gates) {
        // Evaluate whether the gate should activate based on its condition
        let gateActive = false;

        if (gate.condition === 'always') {
          gateActive = true;
        } else if (gate.condition === 'on-questions') {
          // #958 FR-008/FR-009 — integration + safety-net posting already ran
          // in step 5c above. This branch is now a pure boolean check against
          // the freshly-integrated file (fail-closed per FR-007).
          gateActive = hasPendingClarifications(context.checkoutPath, context.item.issueNumber);
          if (!gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-questions" not met (no pending clarifications) — skipping',
            );
          }
        } else if (gate.condition === 'on-sibling-review') {
          const reviewResult = await checkSiblingReviews(context.linkedPRs, this.logger);
          gateActive = !reviewResult.allApproved;
          if (gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel, statuses: reviewResult.statuses },
              'Gate condition "on-sibling-review" active — not all siblings approved',
            );
            // Flip all siblings to ready-for-review before pausing
            await prManager.markSiblingsReadyForReview(context.linkedPRs);
          } else {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-sibling-review" satisfied — all siblings approved (or none linked)',
            );
          }
        } else if (gate.condition === 'on-remediation-limit') {
          // #1128 FR-007/FR-008: cap the review↔remediate loop on the explicit
          // `remediationCount` (bumped once per remediate execution), NOT the
          // monotonic review `round`. When the count reaches `maxRemediations`
          // AND the verdict is still `changes-required`, pause for the operator
          // instead of looping. The verdict check is load-bearing (Q5=A): a
          // `clean` review that happens to land on the cap round is NOT
          // exhaustion — the remediate seam would correctly proceed to
          // `validate`, so this gate must not pre-empt it. Runs BEFORE the seam.
          const workflowId = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
          // #1162 FR-003 reconcile: after a worker restart or fresh re-clone the
          // disk sidecar may be absent (count reads 0) while Redis still holds
          // the count spent before the restart. Seed the disk sidecar from the
          // durable mirror when Redis > disk (max(disk, redis) — never lowers a
          // spent budget) BEFORE the synchronous gate read, so the existing
          // `readReviewArtifactSync` observes the durable value. Best-effort:
          // Redis-down ⇒ `getValueRaw` returns null ⇒ falls back to disk (G3).
          {
            const { owner, repo, issueNumber } = context.item;
            const branch = context.branch ?? 'no-branch';
            const remediationCountKey = `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`;
            const rawRedis = await deps.phaseTracker?.getValueRaw(remediationCountKey);
            const redisCount = rawRedis != null ? Number.parseInt(rawRedis, 10) : NaN;
            if (Number.isInteger(redisCount)) {
              const diskCount = readReviewArtifactSync(context.checkoutPath, workflowId)?.remediationCount ?? 0;
              if (redisCount > diskCount) {
                await seedRemediationCount(context.checkoutPath, workflowId, redisCount);
              }
            }
          }
          const artifact = readReviewArtifactSync(context.checkoutPath, workflowId);
          const { maxRemediations } = resolveWorkflowOverrides(
            config,
            deps.settings,
            context.item.workflowName,
          );
          gateActive =
            artifact !== null &&
            artifact.remediationCount >= maxRemediations &&
            artifact.verdict === 'changes-required';
          if (gateActive) {
            this.logger.info(
              {
                phase,
                gateLabel: gate.gateLabel,
                remediationCount: artifact?.remediationCount,
                maxRemediations,
              },
              'Gate condition "on-remediation-limit" active — remediation cap reached',
            );
            // #1128 FR-008: post the gate body listing the open findings the
            // operator must triage, plus how to resume with a fresh budget.
            // Best-effort — a comment failure must not fail the pause (SC-005:
            // no blocked:* label is ever applied on this path).
            try {
              const openFindings = (artifact?.findings ?? []).filter(
                (f) => f.status === 'open',
              );
              const findingLines = openFindings.map((f) => {
                const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
                return `- ${location} — ${f.title}`;
              });
              const body = [
                REMEDIATION_LIMIT_MARKER,
                '## Remediation limit reached',
                '',
                `The review↔remediate loop hit its cap of ${maxRemediations} remediation attempts and the latest review still requires changes. The following findings remain open:`,
                '',
                ...(findingLines.length > 0
                  ? findingLines
                  : ['- _(No open findings were recorded.)_']),
                '',
                'Add `completed:remediation-limit` to resume with a fresh remediation budget.',
              ].join('\n');
              // #1154 FR-005: dedupe on the hidden marker so a re-parked cap does
              // not re-post the same comment every resume cycle. The comment is
              // posted to the ISSUE (`addIssueComment(issueNumber)`), so the
              // dedupe MUST read the issue's comments — the earlier PR-side read
              // (`listPrCommentBodies(prNumber)`) never saw the marker and
              // re-posted on every re-park. Independent of whether a PR exists.
              // A failed dedupe read must not suppress the gate body — fall
              // back to posting (a duplicate beats a silent park).
              let alreadyPosted = false;
              try {
                const existingComments = await context.github.getIssueComments(
                  context.item.owner,
                  context.item.repo,
                  context.item.issueNumber,
                );
                alreadyPosted = existingComments.some((c) =>
                  c.body.includes(REMEDIATION_LIMIT_MARKER),
                );
              } catch (error) {
                this.logger.warn(
                  { error: String(error), phase, gateLabel: gate.gateLabel },
                  'Remediation-limit comment dedupe read failed — posting without dedupe',
                );
              }
              if (!alreadyPosted) {
                await context.github.addIssueComment(
                  context.item.owner,
                  context.item.repo,
                  context.item.issueNumber,
                  body,
                );
              }
            } catch (error) {
              this.logger.warn(
                { error: String(error), phase, gateLabel: gate.gateLabel },
                'Failed to post remediation-limit gate body — continuing to pause',
              );
            }
          }
        } else if (gate.condition === 'on-ci-green') {
          // #1133 FR-005: the relocated `implementation-review` gate only fires
          // when the CI merge-readiness wait above resolved to `green`. A
          // `not-passed` verdict leaves `ciMergeVerdict === 'not-passed'` and a
          // `timeout` already short-circuited before this loop, so this branch
          // never sees it.
          gateActive = ciMergeVerdict === 'green';
          if (gateActive) {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel },
              'Gate condition "on-ci-green" active — CI is green, raising implementation-review',
            );
          } else {
            this.logger.info(
              { phase, gateLabel: gate.gateLabel, ciMergeVerdict },
              'Gate condition "on-ci-green" not met — CI not green, gate not raised',
            );
          }
        }

        if (!gateActive) continue;

        // Check if this gate is already satisfied (e.g., completed:clarification
        // was added before the workflow reached this point). The completed label
        // corresponds to the gate label suffix: waiting-for:X → completed:X.
        const gateSuffix = gate.gateLabel.replace(/^waiting-for:/, '');
        const completedLabel = `completed:${gateSuffix}`;

        if (!currentLabels) {
          const currentIssue = await context.github.getIssue(context.item.owner, context.item.repo, context.item.issueNumber);
          currentLabels = currentIssue.labels.map((l) => typeof l === 'string' ? l : l.name);
        }

        if (currentLabels.includes(completedLabel)) {
          this.logger.info(
            { phase, gateLabel: gate.gateLabel, completedLabel },
            'Gate already satisfied — skipping pause',
          );
          // #1128 FR-009/FR-010: the remediation-limit gate is special — resuming
          // it must reset the counter to 0 AND remove the operator label so the
          // gate re-arms for a fresh budget. GATE_MAPPING['remediation-limit']
          // stays { phase: 'review', resumeFrom: 'review' } unchanged. Every
          // other gate keeps today's plain skip-and-continue.
          if (completedLabel === 'completed:remediation-limit') {
            const { owner, repo, issueNumber } = context.item;
            const workflowId = `${owner}/${repo}#${issueNumber}`;
            await resetRemediationCount(context.checkoutPath, workflowId);
            // #1162 FR-003 reset: clear the durable Redis mirror so a fresh
            // budget also clears the persisted count (best-effort no-op when
            // Redis is down). Mirrors the disk `resetRemediationCount` above.
            const branch = context.branch ?? 'no-branch';
            await deps.phaseTracker?.clearRaw(
              `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`,
            );
            await context.github.removeLabels(
              owner,
              repo,
              issueNumber,
              ['completed:remediation-limit'],
            );
            this.logger.info(
              { phase, gateLabel: gate.gateLabel, workflowId },
              'Remediation-limit gate resumed — counter reset and gate re-armed',
            );
          }
          continue;
        }

        // Gate is active and not already satisfied — pause the workflow
        this.logger.info(
          { phase, gateLabel: gate.gateLabel },
          'Gate hit, pausing workflow',
        );

        // Emit job:paused before gate label management
        jobEventEmitter?.('job:paused', {
          jobId: context.jobId,
          workflowName: context.item.workflowName,
          owner: context.item.owner,
          repo: context.item.repo,
          issueNumber: context.item.issueNumber,
          status: 'paused',
          currentStep: phase,
          gateLabel: gate.gateLabel,
        });

        // #1133 FR-006 fix: the CI-merge gate is a POST-completion approval gate
        // — `validate` genuinely finished (tests passed, PR marked ready, CI
        // green) before it pauses. Grant `completed:validate` now, at the pause,
        // so (a) cockpit's TERMINAL_COMPLETED_LABELS surface treats the PR as
        // merge-eligible while it waits for approval and (b) the approve→resume
        // terminal no-op at loop entry — which keys on both `completed:validate`
        // AND `completed:implementation-review` — actually fires, so `validate`
        // does not re-run (re-test / re-mark-ready / re-wait-CI). This is the one
        // gate where `completed:<phase>` is granted at pause; every other gate
        // keeps the #958 FR-008 ordering (granted only after all gates skip)
        // because their phase has NOT completed. Order matters: onPhaseComplete
        // removes `phase:validate` + adds `completed:validate`, then onGateHit
        // adds the pause pair — end state is completed:validate +
        // waiting-for:implementation-review + agent:paused.
        if (gate.condition === 'on-ci-green') {
          await labelManager.onPhaseComplete(phase);
          // The review↔remediate loop has CONVERGED here (validate green, CI
          // green) even though the loop returns `completed: false` for the
          // approval pause. Clear the Redis remediation-budget mirror now: a
          // later `address-pr-feedback` re-entry (reviewer requests changes at
          // this gate) clears the disk artifact and must start with a fresh
          // budget, not inherit the N remediations spent before convergence —
          // otherwise the gate's `max(disk, redis)` reconcile re-seeds N and the
          // human's feedback parks at `waiting-for:remediation-limit` with zero
          // attempts. Non-converged exits (merge-conflicts, ci, failures) keep
          // the mirror so the cap stays global across those re-entries.
          await this.clearRemediationBudgetMirror(context, deps);
        }

        await labelManager.onGateHit(phase, gate.gateLabel);

        // #958 FR-009 — safety-net posting moved to step 5c so it runs on any
        // clarify-phase completion, not only when the gate activates.

        // Update the result with gate info
        result.gateHit = {
          gateLabel: gate.gateLabel,
          reason: `Review gate "${gate.gateLabel}" activated after phase "${phase}"`,
        };

        // Record completion time before gate pause
        const ts = phaseTimestamps.get(phase);
        if (ts) ts.completedAt = new Date().toISOString();

        // Update stage comment showing gate hit
        await stageCommentManager.updateStageComment({
          stage,
          status: 'in_progress',
          phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'complete'),
          startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
          prUrl: context.prUrl,
        });

        return { results, completed: false, lastPhase: phase, gateHit: true };
      }

      // `completed:review` must mean "review reached a CLEAN verdict", not
      // merely "the review phase executed". A `changes-required` verdict means
      // the loop is about to remediate + re-review, so granting completed:review
      // here would (a) misreport progress (cockpit STAGE_COMPLETE_PIPELINE_ORDER
      // treats it as a stage-complete marker) and (b) let a label-derived resume
      // resolve straight past the open review into `validate` (the merge-conflict
      // path in claude-cli-worker documents exactly this trap). Read the verdict
      // up front so the grant can be gated on it. Verdict is strictly
      // `clean` | `changes-required`, so `!== 'clean'` aligns with the
      // remediateTrigger and on-remediation-limit gate, both of which key on the
      // sidecar — never on this label — so withholding the label is safe.
      const reviewArtifactRead =
        phase === 'review' && result.success && deps.readFindingsArtifact
          ? await deps.readFindingsArtifact(context)
          : null;

      // 6b. #958 FR-008 — grant `completed:<phase>` only after every gate
      // evaluation returned "skip" (either not active, or already satisfied).
      // The pre-#958 placement (before gate check) meant any code path that
      // skipped the gate left the advance-authorizing label in place. This
      // ordering also lets `LabelManager.onGateHit` drop its dead-code
      // retract-the-completed-label branch (T012).
      if (
        phase === 'review'
        && reviewArtifactRead
        && reviewArtifactRead.artifact.verdict !== 'clean'
      ) {
        // Review ran but requires changes — clear phase:review WITHOUT granting
        // completed:review; the clean grant lands on the converging pass.
        await labelManager.onPhaseExecutedWithoutCompletion(phase);
      } else {
        await labelManager.onPhaseComplete(phase);
      }

      // 7. Record phase completion time
      const phaseTs = phaseTimestamps.get(phase);
      if (phaseTs) phaseTs.completedAt = new Date().toISOString();

      // 8. Update stage comment showing phase complete
      const isLastPhaseInStage =
        i + 1 >= sequence.length || PHASE_TO_STAGE[sequence[i + 1]!] !== stage;

      await stageCommentManager.updateStageComment({
        stage,
        status: isLastPhaseInStage ? 'complete' : 'in_progress',
        phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'complete'),
        startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
        ...(isLastPhaseInStage ? { completedAt: new Date().toISOString() } : {}),
        prUrl: context.prUrl,
      });

      // Clear output buffer for next phase
      outputCapture.clear();

      // #1125: review side effects. Only runs when the injectable seam is wired.
      // #1156 (FR-005): the round is read from the sidecar (authoritative,
      // monotonic across pause/re-entry), NOT the loop-local `reviewRound` which
      // resets each run and would defeat the re-review dedupe + `round >= 2`
      // thread-resolution gate. Posts one COMMENT review, resolves prior threads
      // on re-review, and marks the PR ready when the verdict is clean (before
      // validate by linear order). All best-effort — poster/PR calls never throw.
      if (
        phase === 'review'
        && result.success
        && deps.readFindingsArtifact
        && deps.reviewPoster
      ) {
        // Reuse the artifact already read above for the completed:review gating
        // (same canonical sidecar) instead of reading it a second time.
        const read = reviewArtifactRead;
        if (read) {
          const { artifact, blockingSeverity } = read;
          await deps.reviewPoster.postRound(artifact.findings, artifact.round, blockingSeverity);
          if (artifact.round >= 2) {
            await deps.reviewPoster.resolveResolvedThreads(artifact.findings);
          }
          if (artifact.verdict === 'clean') {
            await prManager.markReadyForReview(context.linkedPRs);
            // #1154 FR-006: a clean review means any earlier remediation-limit
            // answer is spent. Defensively clear a lingering
            // `completed:remediation-limit` so it cannot silently pre-satisfy a
            // later cap pause (distinct from and additional to the reset-branch
            // removal in the gate-resume path). Best-effort — a failure here
            // must not fail the phase.
            try {
              const issueLabels = await context.github.getIssueLabels(
                context.item.owner,
                context.item.repo,
                context.item.issueNumber,
              );
              if (issueLabels.includes('completed:remediation-limit')) {
                await context.github.removeLabels(
                  context.item.owner,
                  context.item.repo,
                  context.item.issueNumber,
                  ['completed:remediation-limit'],
                );
              }
            } catch (error) {
              this.logger.warn(
                { error: String(error) },
                'Failed to clear lingering completed:remediation-limit on clean review — continuing',
              );
            }
          }
        }
      }

      // #1121: off-sequence `remediate` seam. After `review` completes
      // successfully, an injected trigger may drive a `remediate` pass that then
      // re-enters `review`. Inert only when the trigger is left at its
      // `undefined` default; wired live in production via claude-cli-worker.ts.
      if (phase === 'review' && result.success && deps.remediateTrigger?.(context)) {
        this.logger.info('review complete — remediateTrigger fired; running off-sequence remediate');
        // #1125 FR-006: if the engine previously marked this PR ready, convert
        // it back to draft before remediating. No-op unless the engine holds it
        // ready (never demotes a human-marked-ready PR).
        await prManager.convertToDraftIfEngineMarkedReady(context.linkedPRs);
        await labelManager.onPhaseStart('remediate');
        // #1158 (US1, G1/G2): both origins — review-origin AND validate-origin —
        // now converge on the single `RemediateExecutor` (falling back to the
        // inert stub when no executor is wired). The retired `ValidateFixHandler`
        // adapter and its separate self-commit path are gone; the synthesized
        // `changes-required` finding written at the validate-routing block feeds
        // the executor's charter via `readReviewArtifact`. This makes both
        // origins consume the shared `remediationCount` budget identically.
        const remediateResult = deps.remediateExecutor
          ? await deps.remediateExecutor.execute(context)
          : this.runStubPhase('remediate');
        // #1158 (US1, G3/G4 / FR-007): gate commit/push on the executor outcome.
        // Push a clean-run zero exit OR a timeout-kill (partial work is worth
        // keeping); a clean-run NON-zero exit means the fixer failed without
        // producing usable changes, so leave the branch untouched.
        const shouldPush =
          remediateResult.exitCode === 0 || remediateResult.timedOut === true;
        if (shouldPush) {
          // #1128 FR-003: commit + push the remediation changes (and whatever
          // partial work a timed-out CLI left behind) before re-reviewing.
          const remediateCommitOutcome = await prManager.commitPushAndEnsurePr('remediate');
          // #1051: a refused push MUST abort the loop — never open a duplicate PR
          // or advance on a phantom no-op.
          if (remediateCommitOutcome.pushRefused) {
            this.logger.warn(
              { phase: 'remediate', refusal: remediateCommitOutcome.pushRefused },
              'Phase loop aborted: pre-push guard refused remediate cycle — see prior push-refused log',
            );
            return { results, completed: false, lastPhase: 'remediate', gateHit: false };
          }
          if (remediateCommitOutcome.prUrl) {
            context.prUrl = remediateCommitOutcome.prUrl;
          }
          // #1162 FR-003 mirror: the executor bumped `remediationCount` on the
          // disk sidecar; persist that post-bump count to the durable Redis
          // mirror so it survives a worker restart / re-clone (the disk sidecar
          // is no longer committed to the branch after this fix). Best-effort —
          // no-op when Redis is down (G3). Keyed identically to the reconcile +
          // reset sites so all three operate on the same durable value.
          const { owner, repo, issueNumber } = context.item;
          const workflowId = `${owner}/${repo}#${issueNumber}`;
          const remediationCount = readReviewArtifactSync(
            context.checkoutPath,
            workflowId,
          )?.remediationCount;
          if (remediationCount !== undefined) {
            const branch = context.branch ?? 'no-branch';
            await deps.phaseTracker?.setValueRaw(
              `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`,
              String(remediationCount),
              PHASE_START_REF_TTL_SECONDS,
            );
          }
        } else {
          this.logger.warn(
            { phase: 'remediate', exitCode: remediateResult.exitCode },
            '#1158: remediate exited non-zero without a timeout — skipping commit/push (branch untouched)',
          );
          // #1158 FR-007 / SC-005: honoring "branch untouched" requires
          // reverting the working tree, not just skipping the commit. A
          // clean-run fixer that exits non-zero may still have left dirty
          // tracked files and/or new untracked files behind. On the `i--`
          // re-entry, step 5's `commitPushAndEnsurePr('review')` runs
          // getStatus → has_changes → stageAll → commit, which would stage
          // ALL working-tree changes — landing the abandoned partial fix on
          // the branch under a 'complete review phase' commit. Hard-reset +
          // clean first, excluding `.generacy` so the review sidecar (round /
          // markedReadyByEngine carry-forward) survives. If the revert itself
          // fails we cannot guarantee a clean branch, so abort rather than
          // risk committing the garbage the guarantee exists to keep off.
          try {
            await context.github.discardWorkingTreeChanges(['.generacy']);
          } catch (error) {
            this.logger.error(
              { phase: 'remediate', error: String(error) },
              '#1158: failed to revert working tree after skipped remediate push — aborting to preserve branch-untouched guarantee',
            );
            return { results, completed: false, lastPhase: 'remediate', gateHit: false };
          }
        }
        // #1158 T014: clear the validate-origin flag AFTER the executor runs so
        // the following review re-entry runs the REAL executor to verify the fix
        // (a validate-origin backtrack stubs only the first review pass).
        pendingValidateRemediation = false;
        await labelManager.onPhaseComplete('remediate');
        results.push(remediateResult);
        outputCapture.clear();
        i--; // Re-enter the review phase
        continue;
      }
    }

    this.logger.info('Phase loop completed successfully — all phases done');
    await this.clearRemediationBudgetMirror(context, deps);
    return {
      results,
      completed: true,
      lastPhase: sequence[sequence.length - 1]!,
      gateHit: false,
    };
  }

  /**
   * Clear the durable Redis mirror of the remediation budget
   * (`remediation-count:<owner>:<repo>:<issue>:<branch>`) on a SUCCESSFUL
   * loop completion (`completed: true`). The mirror must persist across every
   * non-completing exit (gate pauses, failures, push refusals) so a restart
   * resumes with the spent budget; but a workflow that converged after N
   * remediations would otherwise leave N in Redis, and a later re-entry
   * (e.g. address-pr-feedback, which clears the disk sidecar and re-seeds at
   * 0) would reconcile `max(disk, redis)` back up to N — parking the human's
   * feedback at the cap with zero attempts when N ≥ max. Best-effort: a Redis
   * failure never changes the completion outcome.
   */
  private async clearRemediationBudgetMirror(
    context: WorkerContext,
    deps: PhaseLoopDeps,
  ): Promise<void> {
    if (!deps.phaseTracker) return;
    const { owner, repo, issueNumber } = context.item;
    const branch = context.branch ?? 'no-branch';
    const key = `remediation-count:${owner}:${repo}:${issueNumber}:${branch}`;
    try {
      await deps.phaseTracker.clearRaw(key);
      this.logger.info({ key }, 'Phase loop completed — cleared remediation budget mirror');
    } catch (error) {
      this.logger.warn(
        { key, error: String(error) },
        'Failed to clear remediation budget mirror on completion — continuing',
      );
    }
  }

  /**
   * #1121: inert stub executor for the `review` and `remediate` phases. Returns
   * a synthetic success without spawning the CLI. Real executors, prompts, and
   * verdict/finding logic land in later epic issues.
   */
  private runStubPhase(phase: 'review' | 'remediate'): PhaseResult {
    return { phase, success: true, exitCode: 0, durationMs: 0, output: [] };
  }

  /**
   * #1165 Corner 1 (T003): synthesize a `changes-required` review artifact for a
   * failing `validate` phase and persist it. One `critical` open `ReviewFinding`
   * cites the effective (possibly targeted) validate command with fenced/bounded
   * stdout+stderr, carrying the accumulated `remediationCount` and cross-run
   * `markedReadyByEngine` forward from any prior artifact. Shared by the flag-ON
   * validate-routing block and the flag-OFF validate-fix fallback so the two
   * paths cannot diverge. Returns the new `round` for the caller's log line.
   */
  private async synthesizeValidateChangesRequiredArtifact(
    context: WorkerContext,
    // Retained for call-site stability; the finding id now derives from the
    // EFFECTIVE command (the `file` field) so a reviewer re-emission with the
    // same `file` + `title` yields the same deterministic id (INV-4).
    _validateCommand: string,
    effectiveValidateCommand: string,
    validateEvidence: { stdout: string; stderr: string },
  ): Promise<{ round: number }> {
    const workflowId = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    const prior = await readReviewArtifact(context.checkoutPath, workflowId);
    const round = (prior?.round ?? 0) + 1;
    const head = await context.github.getCurrentCommitSha();
    const finding: ReviewFinding = {
      id: deriveFindingId(effectiveValidateCommand, 'validate phase failed'),
      severity: 'critical',
      // #1158 T013 (FR-008): cite the effective (possibly targeted) command,
      // not the flat `config.validateCommand`.
      file: effectiveValidateCommand,
      title: 'validate phase failed',
      // No path anchor: `file` is a command string that can never appear in a
      // review delta. Tag it so `advanceArtifact` resolves it on the reviewer's
      // re-emission alone, and so a green validate can auto-resolve it
      // (`resolveSyntheticValidateFindings`). Without this the finding rode
      // every validate failure to the remediation cap.
      synthetic: 'validate',
      // #1159 FR-005: raw validate stdout/stderr can contain
      // attacker-influenced content (e.g. a test name or assertion message
      // echoing a PR-controlled string) that lands verbatim in the remediate
      // charter. Fence it at ingestion so it renders as data, mirroring
      // validate-fix-handler.ts:235.
      detail: wrapUntrustedData(
        boundOutputTail(`${validateEvidence.stdout}\n${validateEvidence.stderr}`),
        'validate-output',
      ),
      round,
      status: 'open',
    };
    await writeReviewArtifact(context.checkoutPath, workflowId, {
      // A repeat validate failure re-synthesizes a finding with the SAME
      // deterministic id (same command + title). Replace any prior copy —
      // typically the one a review just resolved — rather than appending a
      // duplicate id, which would break the id-uniqueness invariant the
      // convergence merge and the poster's thread marker rely on.
      findings: [...(prior?.findings ?? []).filter((f) => f.id !== finding.id), finding],
      verdict: 'changes-required',
      round,
      lastReviewedCommitSha: head,
      // #1128 compose: carry the accumulated remediation budget forward across
      // the re-synthesis so the `on-remediation-limit` cap still bounds the
      // loop (a validate failure must not silently reset the budget).
      remediationCount: prior?.remediationCount ?? 0,
      // #1156: carry the cross-run ready flag forward (D-7 — same reasoning as
      // the review executor's per-round rewrite).
      markedReadyByEngine: prior?.markedReadyByEngine ?? false,
      // Carry the scoped-review consumption marker forward so a validate
      // failure after a merge-conflict re-arm does not re-apply the scope.
      ...(prior?.consumedReviewScopeHeadSha !== undefined
        ? { consumedReviewScopeHeadSha: prior.consumedReviewScopeHeadSha }
        : {}),
    });
    return { round };
  }

  /**
   * Validate-SUCCESS counterpart of `synthesizeValidateChangesRequiredArtifact`.
   * A passing `validate` is the proof that every validate-origin failure is
   * fixed, so flip any still-open `synthetic: 'validate'` finding in the
   * sidecar to `resolved` and recompute the verdict. Covers the paths where no
   * review round gets to confirm the fix — the flag-OFF one-shot remediate
   * (#1165), a resume that re-enters at `validate`, or a reviewer that omitted
   * the re-emission — so the stale `changes-required` cannot re-trigger
   * remediate on the next review entry. No-op when there is no artifact or no
   * open synthetic validate finding; leaves every other field untouched.
   * Best-effort: a sidecar I/O failure is logged, never fatal to a green run.
   */
  private async resolveSyntheticValidateFindings(
    context: WorkerContext,
    blockingSeverity: Severity,
  ): Promise<void> {
    const workflowId = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    try {
      const artifact = await readReviewArtifact(context.checkoutPath, workflowId);
      if (!artifact) {
        return;
      }
      const stale = artifact.findings.filter(
        (f) => f.status === 'open' && f.synthetic === 'validate',
      );
      if (stale.length === 0) {
        return;
      }
      const findings: ReviewFinding[] = artifact.findings.map((f) =>
        f.status === 'open' && f.synthetic === 'validate'
          ? { ...f, status: 'resolved' as const }
          : f,
      );
      // Recompute with the single `computeVerdict` at the per-workflow blocking
      // severity so this agrees with the review executor: any other open
      // blocking finding keeps the verdict at changes-required.
      const verdict = computeVerdict(findings, blockingSeverity);
      await writeReviewArtifact(context.checkoutPath, workflowId, {
        ...artifact,
        findings,
        verdict,
      });
      this.logger.info(
        { workflowId, resolved: stale.map((f) => f.id), verdict },
        'validate passed — auto-resolved open synthetic validate findings',
      );
    } catch (error) {
      this.logger.warn(
        { error: String(error), workflowId },
        'validate passed but auto-resolving synthetic validate findings failed — continuing',
      );
    }
  }

  /**
   * #1134 (US2 / FR-009): classify the branch diff and compute the effective
   * validate command for a speckit-bugfix run. Only the built-in default command
   * is rewritten (Q1=B) — a custom `validateCommand` runs verbatim, but the
   * classification is still computed and logged for observability. Emits exactly
   * one `targeted-validate` log line per validate entry describing the decision.
   *
   * Built-in-default detection compares against the RESOLVED per-workflow
   * validate command (workflow → repo → cluster), not the raw
   * `config.validateCommand`, so an operator who sets
   * `settings.workflows['speckit-bugfix'].validateCommand` while leaving the
   * cluster default untouched still gets their custom command run verbatim (Q1=B).
   *
   * Diff resolution (`resolveBaseRef` network call + `getFilesChangedBetween`
   * `git diff base...HEAD`, which throws on a non-zero exit — e.g. `origin/<base>`
   * not fetched locally) is wrapped in try/catch: any failure falls back to the
   * plain resolved command so speckit-bugfix validate stays byte-identical to its
   * pre-#1134 behavior when the diff can't be computed (FR-013).
   */
  private async resolveTargetedValidate(
    context: WorkerContext,
    prManager: PrManager,
    config: WorkerConfig,
    settings: OrchestratorSettings | null | undefined,
  ): Promise<TargetedValidateDecision> {
    const resolvedValidateCommand = resolveWorkflowOverrides(
      config,
      settings,
      context.item.workflowName,
    ).validateCommand;
    const isBuiltInDefault = resolvedValidateCommand === DEFAULT_VALIDATE_COMMAND;

    // #1166 (FR-010): resolve the base ref up front, in its own try, so a custom
    // command's `<base>` placeholder is substituted even when the diff
    // computation below fails — a `<base>` command must never reach the shell
    // with the literal placeholder. `resolveBaseRef` (base selection from PR
    // metadata/config) succeeds even when `origin/<base>` isn't fetched locally;
    // the git diff is the part that throws in that case.
    let baseRef: string;
    let base: string;
    try {
      baseRef = await resolveBaseRef(
        context.github,
        prManager,
        context.item.owner,
        context.item.repo,
      );
      base = baseRef.startsWith('origin/') ? baseRef.slice('origin/'.length) : baseRef;
    } catch (error) {
      this.logger.warn(
        { event: 'targeted-validate', error: String(error) },
        '#1134: targeted-validate base ref resolution failed — falling back to plain validate command',
      );
      return {
        effectiveCommand: this.computeEffectiveValidateCommand(
          { kind: 'full-fallback', reason: 'diff-resolution-failed' },
          resolvedValidateCommand,
          '',
          isBuiltInDefault,
        ),
        baseRef: '',
        base: '',
        changedFiles: [],
        classification: { kind: 'full-fallback', reason: 'diff-resolution-failed' },
      };
    }

    let changedFiles: string[];
    let classification: Classification;
    try {
      changedFiles = await context.github.getFilesChangedBetween(baseRef, 'HEAD');
      // #1166 (FR-001/FR-002): keep only paths that still exist in the branch
      // checkout. A deletion-only or rename diff otherwise reaches the classifier
      // (and the fail-then-pass `changedFiles.filter(isTestFile)` caller) with
      // phantom paths, yielding a `pnpm vitest run <nonexistent-file>`. An
      // all-filtered diff → empty set → `classifyDiff` returns
      // `full-fallback('empty-diff')` → the full built-in default runs.
      changedFiles = changedFiles.filter((f) => existsSync(join(context.checkoutPath, f)));
      const isWorkspace = existsSync(join(context.checkoutPath, 'pnpm-workspace.yaml'));
      classification = classifyDiff({ changedFiles, isWorkspace });
    } catch (error) {
      this.logger.warn(
        { event: 'targeted-validate', error: String(error) },
        '#1134: targeted-validate diff resolution failed — falling back to plain validate command',
      );
      return {
        effectiveCommand: this.computeEffectiveValidateCommand(
          { kind: 'full-fallback', reason: 'diff-resolution-failed' },
          resolvedValidateCommand,
          base,
          isBuiltInDefault,
        ),
        baseRef,
        base,
        changedFiles: [],
        classification: { kind: 'full-fallback', reason: 'diff-resolution-failed' },
      };
    }

    let effectiveCommand = this.computeEffectiveValidateCommand(
      classification,
      resolvedValidateCommand,
      base,
      isBuiltInDefault,
    );

    // #1166 (FR-003): zero-project fallback. A root-only non-package change (root
    // `package.json`, `scripts/**`, root `vitest.config.ts`) can classify
    // `targeted`/`docs-only-skip-tests` yet select zero pnpm projects, producing
    // a vacuous `pnpm --filter … build/test`. Probe the selection; an empty
    // selection — or a probe error (fail-safe) — overrides to the full default.
    //
    // The probe only ever fires when the diff touches a root-level path that
    // belongs to NO workspace package (the exact FR-003 trigger set: root
    // `package.json`, `scripts/**`, root `vitest.config.ts`). A change that lives
    // under a package directory (has a `package.json` ancestor in the checkout)
    // is guaranteed to be in the `...[origin/<base>]` selection — it is itself a
    // change to that package vs the base ref — so probing is provably redundant
    // and is skipped (avoids a spawn on the common package-scoped path).
    const hasRootLevelChange = changedFiles.some(
      (f) => !this.pathBelongsToPackage(context.checkoutPath, f),
    );
    if (
      isBuiltInDefault &&
      hasRootLevelChange &&
      (classification.kind === 'targeted' || classification.kind === 'docs-only-skip-tests')
    ) {
      const selectsZero = await this.probeSelectsZeroProjects(context.checkoutPath, base);
      if (selectsZero) {
        effectiveCommand = resolvedValidateCommand;
        this.logger.info(
          {
            event: 'targeted-validate',
            reason: 'zero-project-fallback',
            base,
            effectiveCommand,
          },
          '#1166: targeted-validate selected zero projects — falling back to full validate command',
        );
        return { effectiveCommand, baseRef, base, changedFiles, classification };
      }
    }

    this.logger.info(
      {
        event: 'targeted-validate',
        classification: classification.kind,
        isBuiltInDefault,
        base,
        effectiveCommand,
      },
      '#1134: targeted-validate decision',
    );

    return { effectiveCommand, baseRef, base, changedFiles, classification };
  }

  /**
   * #1166 (FR-003): does a changed path live inside a workspace package — i.e.
   * does any ancestor directory (up to, but excluding, the checkout root) hold a
   * `package.json`? A path that does is guaranteed to be in the targeted
   * `...[origin/<base>]` selection (it is a change to that package vs the base),
   * so the zero-project probe can be skipped for it. Root-level paths (root
   * `package.json`, `scripts/**`, root `vitest.config.ts`) return `false` — they
   * are the only paths that can produce a vacuous zero-project targeted command.
   * Pure fs probing in the wiring layer (Q3=A keeps `classifyDiff` no-I/O).
   */
  private pathBelongsToPackage(checkoutPath: string, file: string): boolean {
    let dir = dirname(file);
    while (dir && dir !== '.' && dir !== '/') {
      if (existsSync(join(checkoutPath, dir, 'package.json'))) {
        return true;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  }

  /**
   * #1166 (FR-003): probe whether the targeted pnpm filter selects any project.
   * Routes through the same `execFile` path the tests mock — no new production
   * DI surface. Returns `true` when the selection is empty OR the probe errors
   * (fail-safe — never emit an unverified targeted command).
   */
  private async probeSelectsZeroProjects(checkoutPath: string, base: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'pnpm',
        ['ls', '--filter', `...[origin/${base}]`, '--depth', '-1', '--json'],
        { cwd: checkoutPath },
      );
      const parsed: unknown = JSON.parse(stdout);
      return !Array.isArray(parsed) || parsed.length === 0;
    } catch {
      return true;
    }
  }

  /**
   * #1134 (US2): pure resolution of the effective validate command from the
   * classification (see `data-model.md` resolution table). Custom commands run
   * verbatim; only the built-in default is narrowed.
   */
  private computeEffectiveValidateCommand(
    classification: Classification,
    validateCommand: string,
    base: string,
    isBuiltInDefault: boolean,
  ): string {
    if (!isBuiltInDefault) {
      // #1166 (FR-010): custom commands run verbatim except for the `<base>`
      // placeholder, substituted with the resolved base branch (mirrors the
      // merge-conflict `<base>`/`<branch>` substitution). Works on both
      // `develop`- and `main`-based repos without hardcoding the base.
      return validateCommand.replace(/<base>/g, base);
    }
    const filter = `"...[origin/${base}]"`;
    switch (classification.kind) {
      case 'targeted':
        return `pnpm --filter ${filter} build && pnpm --filter ${filter} test`;
      case 'docs-only-skip-tests':
        return `pnpm --filter ${filter} build`;
      case 'test-only':
        return `pnpm vitest run ${classification.testFiles.join(' ')}`;
      case 'single-package-plain':
      case 'full-fallback':
        return validateCommand;
    }
  }

  /**
   * #1134 (US3 / FR-011): opt-in fail-then-pass regression proof. Computes the
   * changed test-file set (diff ∩ test globs) and, when non-empty, verifies the
   * files fail on the base ref and pass on the branch. Returns a failing
   * `PhaseResult` (surfacing the evidence) when the proof does not hold, or
   * `undefined` to let the normal validate run proceed.
   */
  private async runFailThenPassCheck(
    context: WorkerContext,
    targetedValidate: TargetedValidateDecision,
  ): Promise<PhaseResult | undefined> {
    const changedTestFiles = targetedValidate.changedFiles.filter(isTestFile);
    const outcome = await runFailThenPass({
      checkoutPath: context.checkoutPath,
      baseRef: targetedValidate.baseRef,
      changedTestFiles,
      signal: context.signal,
    });

    if (outcome.kind === 'fail') {
      this.logger.warn(
        { event: 'fail-then-pass', reason: outcome.reason },
        '#1134: fail-then-pass regression proof failed',
      );
      return {
        phase: 'validate',
        success: false,
        exitCode: 1,
        durationMs: 0,
        output: [],
        capturedStdout: outcome.evidence,
        error: {
          message: `fail-then-pass: ${outcome.reason}`,
          output: outcome.evidence,
          phase: 'validate',
        },
      };
    }

    if (outcome.kind === 'skip') {
      // Base env couldn't be prepared (e.g. dependency install failed). Do not
      // block validate on an infrastructure failure — proceed to normal validate.
      this.logger.warn(
        { event: 'fail-then-pass', outcome: 'skip', reason: outcome.reason },
        '#1134: fail-then-pass regression proof skipped',
      );
      return undefined;
    }

    // noop / pass → let the normal validate run proceed.
    return undefined;
  }

  /**
   * #1051 FR-003: react to a `refuse` decision from the phase-loop-entry
   * push guard. Emits the same warn shape as `PrFeedbackHandler.handlePushRefused`
   * and `PrManager.handlePushRefused` so a grep for `event: 'push-refused'`
   * reveals all three refusal sites (T061).
   */
  private async handlePhaseLoopPushRefused(
    context: WorkerContext,
    decision: Extract<PushGuardDecision, { kind: 'refuse' }>,
  ): Promise<void> {
    const { reason, prNumber, branch, owner, repo, issueNumber } = decision;
    this.logger.warn(
      { event: 'push-refused', reason, prNumber, branch, owner, repo, issueNumber },
      'Refusing phase loop entry — PR state or remote branch state indicates a resurrection or duplicate-PR attempt',
    );

    let issueState: 'open' | 'closed' = 'open';
    try {
      const issue = await context.github.getIssue(owner, repo, issueNumber);
      issueState = issue.state;
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePhaseLoopPushRefused: failed to read issue state — assuming open',
      );
    }

    try {
      await context.github.removeLabels(owner, repo, issueNumber, ['agent:in-progress']);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePhaseLoopPushRefused: failed to remove agent:in-progress — non-fatal',
      );
    }

    if (issueState === 'open') {
      try {
        await context.github.addLabels(owner, repo, issueNumber, ['agent:error']);
      } catch (error) {
        this.logger.warn(
          { error: String(error), issueNumber },
          'handlePhaseLoopPushRefused: failed to add agent:error — non-fatal',
        );
      }
    }
  }

  /**
   * Run the pre-implement base-merge (#864, committed). On conflict, pause the
   * workflow via `waiting-for:merge-conflicts` and return the pause result;
   * on clean merge, return `undefined` so the caller proceeds with phase execution.
   */
  private async runPreImplementBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
  ): Promise<PhaseLoopResult | undefined> {
    return this.runPrePhaseBaseMerge(
      context,
      deps,
      baseMergeRunner,
      phase,
      stage,
      sequence,
      startIndex,
      i,
      phaseTimestamps,
      { commit: true },
    );
  }

  /**
   * Run the pre-validate/validate base-merge (#864, ephemeral). Symmetric with
   * `runPreImplementBaseMerge` but `opts.commit === false` — the merge is left
   * as an un-committed merge in the workspace and MUST be discarded by the next
   * phase's reset-at-start (FR-006).
   */
  private async runPreValidateBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
  ): Promise<PhaseLoopResult | undefined> {
    return this.runPrePhaseBaseMerge(
      context,
      deps,
      baseMergeRunner,
      phase,
      stage,
      sequence,
      startIndex,
      i,
      phaseTimestamps,
      { commit: false },
    );
  }

  /**
   * Shared pre-phase base-merge implementation. Resolves the base ref, invokes
   * the runner, and (on conflict) pauses with `waiting-for:merge-conflicts` +
   * `errorEvidence.mergeConflict`. Reuses the existing gate-return path so
   * #849's paired resume-dedupe clear applies symmetrically.
   */
  private async runPrePhaseBaseMerge(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    baseMergeRunner: BaseMergeRunner,
    phase: WorkflowPhase,
    stage: StageType,
    sequence: WorkflowPhase[],
    startIndex: number,
    i: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
    opts: { commit: boolean },
  ): Promise<PhaseLoopResult | undefined> {
    if (!context.branch) {
      this.logger.warn(
        { phase },
        'Skipping pre-phase base-merge — WorkerContext.branch not set',
      );
      return undefined;
    }

    const baseRef = await resolveBaseBranch(
      context.github,
      deps.prManager,
      context.checkoutPath,
      context.item.owner,
      context.item.repo,
      this.logger,
    );

    const mergeResult = await baseMergeRunner(
      context.checkoutPath,
      context.branch,
      baseRef,
      opts,
      this.logger,
    );

    if (mergeResult.ok) {
      this.logger.info(
        { phase, baseRef, commit: opts.commit, mergeSha: mergeResult.mergeSha },
        'Pre-phase base-merge succeeded',
      );
      return undefined;
    }

    // Conflict: pause with merge-conflict gate.
    const gateLabel = 'waiting-for:merge-conflicts';
    this.logger.warn(
      { phase, baseRef, conflictedPaths: mergeResult.conflictedPaths },
      'Pre-phase base-merge conflict — pausing workflow',
    );

    deps.jobEventEmitter?.('job:paused', {
      jobId: context.jobId,
      workflowName: context.item.workflowName,
      owner: context.item.owner,
      repo: context.item.repo,
      issueNumber: context.item.issueNumber,
      status: 'paused',
      currentStep: phase,
      gateLabel,
    });

    // #898 FR-011/FR-012: substitute the manual-remedy template with the
    // concrete branch / bare base / issue-ref for this pause. Keeps the
    // renderer content-agnostic — it just prints the strings as given.
    const bareBase = mergeResult.baseRef.replace(/^origin\//, '');
    const branchName = context.branch ?? '<branch>';
    const issueRef = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    const substitutedSteps = MERGE_CONFLICT_REMEDY.steps.map((step) =>
      step
        .replace(/<branch>/g, branchName)
        .replace(/<base>/g, bareBase)
        .replace(/<issue-ref>/g, issueRef),
    );

    await deps.stageCommentManager.updateStageComment({
      stage,
      status: 'in_progress',
      phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps),
      startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      prUrl: context.prUrl,
      errorEvidence: {
        mergeConflict: {
          baseRef: mergeResult.baseRef,
          conflictedPaths: mergeResult.conflictedPaths,
          manualRemedy: {
            steps: substitutedSteps,
            warning: MERGE_CONFLICT_REMEDY.warning,
          },
        },
      },
    });

    // #902 FR-003: persist pause-context BEFORE applying the pause label.
    // The worker's MergeConflictHandler dispatch reads this to populate
    // `metadata.phase` — the single source of truth for the interrupted phase.
    // If the write throws, we do NOT apply the pause label — the pause simply
    // doesn't materialize, preventing the dead-park class.
    const workflowId = `${context.item.owner}/${context.item.repo}#${context.item.issueNumber}`;
    await writePauseContext(context.checkoutPath, workflowId, {
      phase,
      writtenAt: new Date().toISOString(),
      issueRef: workflowId,
    });

    await deps.labelManager.onGateHit(phase, gateLabel);

    return {
      results: [],
      completed: false,
      lastPhase: phase,
      gateHit: true,
    };
  }

  /**
   * #942: Fingerprint the failure, look up prior identical failures on this
   * issue, escalate labels + post the alert.
   *
   * Order (per contract):
   *   1. Compute fingerprint (pure, non-throwing).
   *   2. Fetch prior-occurrence count (fail-open — errors already suppressed
   *      inside the tracker, so this is always a number).
   *   3. `labelManager.onError(phase)` — unchanged pre-#942 path.
   *   4. If `occurrence >= REPEAT_FAILURE_THRESHOLD` (N=2), also apply the
   *      `-repeated` escalation label BEFORE the alert-post.
   *   5. `stageCommentManager.postFailureAlert({ ..., fingerprint, occurrence })`
   *      — line-1 v2 marker carries the fingerprint hex + occurrence counter.
   */
  private async escalateAndAlert(
    context: WorkerContext,
    deps: PhaseLoopDeps,
    phase: WorkflowPhase | string,
    evidence: CommandExitEvidence,
    stage: StageType | 'label-op',
    runId: string,
  ): Promise<void> {
    const fingerprint = computeFailureFingerprint({ phase, evidence });
    const priorCount = deps.failureFingerprintTracker
      ? await deps.failureFingerprintTracker.countPriorOccurrences(
          context.item.owner,
          context.item.repo,
          context.item.issueNumber,
          fingerprint,
        )
      : 0;
    const occurrence = priorCount + 1;

    // Regular error label first (byte-compatible w/ pre-#942 consumers).
    // `phase` is a WorkflowPhase here for the 6 real phase-loop sites; the
    // `phase: string` union member exists only for `label-op` failures which
    // don't route through this helper today.
    if (isWorkflowPhase(phase)) {
      await deps.labelManager.onError(phase);
      if (occurrence >= REPEAT_FAILURE_THRESHOLD) {
        this.logger.warn(
          {
            phase,
            fingerprint,
            occurrence,
            issue: context.item.issueNumber,
          },
          'Repeat-identical failure detected — escalating with failed:<phase>-repeated',
        );
        await deps.labelManager.onRepeatedError(phase);
      }
    }

    await deps.stageCommentManager.postFailureAlert({
      stage,
      runId,
      phase,
      evidence,
      fingerprint,
      occurrence,
    });
  }

  /**
   * #958 FR-010 — Surface parse failures on the issue + relay event so that
   * "failed to pick up the answers" and "planned anyway" are no longer one
   * event. Best-effort: failures posting the comment are logged and
   * swallowed — the pause itself (via the on-questions gate check that
   * follows) is the load-bearing behavior; this is diagnostic.
   */
  private async reportClarificationParseFailures(
    context: WorkerContext,
    integration: import('./clarification-poster.js').IntegrationResult,
  ): Promise<void> {
    const failures = integration.parseFailures ?? [];
    if (failures.length === 0) return;

    const { owner, repo, issueNumber } = context.item;
    const marker = `<!-- generacy-clarification-parse-failures:${issueNumber} -->`;
    const perQuestion = failures
      .map((f) => `  - Q${f.questionNumber}: ${f.reason}`)
      .join('\n');
    const body = `${marker}\n\n**Clarification answer integration reported parse failures.** The following questions remain \`${PENDING_ANSWER_LITERAL}\` and the phase will re-pause:\n\n${perQuestion}\n\nReply with \`Q<n>: <answer>\` for each failing question; the resume monitor will pick up your reply on the next poll cycle.`;

    try {
      await context.github.addIssueComment(owner, repo, issueNumber, body);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), issueNumber },
        'Failed to post clarification parse-failure comment (non-fatal)',
      );
    }
    this.logger.warn(
      {
        event: 'clarification.parse_failures',
        issueNumber,
        pendingAfter: integration.pendingAfter,
        failures,
      },
      'Clarification integration surfaced parse failures',
    );
  }

  /**
   * Build the `errorEvidence` payload rendered inside the stage comment on
   * `status: 'error'` transitions. See specs/847-found-during-cockpit-v1/
   * contracts/failure-evidence-block.md for the derivation rules.
   */
  private buildErrorEvidence(
    command: string,
    result: PhaseResult,
    resolvedTimeoutMs?: number,
    classifier?: string,
    explicitReason?: string,
  ): CommandExitEvidence {
    const message = result.error?.message ?? '';
    const exitDescriptor = classifier
      ? `failed post-exit: ${classifier} (process exit ${result.exitCode})`
      : message.includes('timed out') && resolvedTimeoutMs !== undefined
        ? `killed (SIGTERM) after ${resolvedTimeoutMs}ms`
        : message.includes('was aborted')
        ? 'aborted'
        : `exit ${result.exitCode}`;

    // Shell path: `error.output` is the ring-buffer tail (already merged).
    // CLI path: `error.output` is empty; synthesize from parsed `type: 'text'` chunks.
    // For synthetic PhaseResults (no-progress guard, product-diff failures, catch
    // block): `error.output` is set directly by the caller (still merged-shape).
    const rawOutput = result.error?.output ?? '';
    const outputTail = rawOutput.length > 0
      ? boundOutputTail(rawOutput)
      : synthesizeOutputTail(result.output);
    // #1158 T005: `classifier` still wins (post-exit classification message);
    // `explicitReason` is the opt-in stable fingerprint reason from the
    // validate-routing block. No other call site passes it, so every existing
    // evidence payload stays byte-identical.
    const reason = classifier ? message : explicitReason;
    return {
      command,
      exitDescriptor,
      outputTail,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /**
   * #1157 FR-001..FR-005: pause the workflow in a recoverable, operator-visible
   * state when CI merge readiness cannot open the gate — red CI (`not-passed`),
   * the merge-readiness `timeout`, or an unresolvable head SHA. All three land
   * in the SAME pause state (`waiting-for:ci` + `agent:paused`, no
   * `completed:validate`), differentiated only by the reason comment/log
   * (Q2→A / Q4→A). Critically this NEVER calls `labelManager.onPhaseComplete`,
   * so the red path can never grant `completed:validate` or reach
   * `completed: true` (INV-1/INV-2). The reason comment is best-effort: a
   * failure is swallowed and never changes the pause outcome (FR-004 / INV-5).
   * On the operator's `continue`, `validate` re-runs (it is the first
   * uncompleted phase — no resolver change, INV-6).
   */
  private async pauseForCiReadiness(params: {
    phase: WorkflowPhase;
    reason: string;
    /**
     * The real CI readout behind the pause: aggregated verdict (`'unknown'`
     * when the head SHA could not be resolved), which readout produced it, and
     * the head SHA evaluated. Reported verbatim in the pause comment and used
     * as the dedupe fingerprint.
     */
    ci: {
      verdict: 'green' | 'not-passed' | 'pending' | 'unknown';
      source?: 'check-runs' | 'actions-runs';
      headSha: string;
    };
    context: WorkerContext;
    deps: PhaseLoopDeps;
    results: PhaseResult[];
    result: PhaseResult;
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>;
    stage: StageType;
    sequence: WorkflowPhase[];
    startIndex: number;
    currentIndex: number;
  }): Promise<PhaseLoopResult> {
    const {
      phase,
      reason,
      ci,
      context,
      deps,
      results,
      result,
      phaseTimestamps,
      stage,
      sequence,
      startIndex,
      currentIndex,
    } = params;
    const { labelManager, stageCommentManager, jobEventEmitter } = deps;
    this.logger.warn(
      { phase, ciVerdict: ci.verdict, ciSource: ci.source ?? 'none', headSha: ci.headSha, reason },
      'CI merge readiness paused',
    );

    jobEventEmitter?.('job:paused', {
      jobId: context.jobId,
      workflowName: context.item.workflowName,
      owner: context.item.owner,
      repo: context.item.repo,
      issueNumber: context.item.issueNumber,
      status: 'paused',
      currentStep: phase,
      gateLabel: 'waiting-for:ci',
    });

    // Adds `waiting-for:ci` + `agent:paused`, removes `phase:<phase>`. MUST NOT
    // call `onPhaseComplete` — the phase did not merge-complete (INV-2).
    await labelManager.onGateHit(phase, 'waiting-for:ci');

    // FR-004: best-effort reason comment. A failure here MUST NOT change the
    // pause outcome or any other step (INV-5). Reports the REAL verdict and
    // its source (not a canned "CI is red"), and is deduped on a hidden
    // marker + verdict/sha fingerprint: when the latest issue comment already
    // carries the same fingerprint (a re-pause on the same head with the same
    // verdict — e.g. every `completed:ci` → validate → re-pause cycle), the
    // comment is not re-posted.
    try {
      const fingerprint = `${CI_PAUSE_MARKER_PREFIX} verdict=${ci.verdict} sha=${ci.headSha} -->`;
      const body = [
        CI_PAUSE_MARKER,
        fingerprint,
        '## CI merge readiness paused',
        '',
        reason,
        '',
        `CI verdict: \`${ci.verdict}\` (source: ${ci.source ?? 'none'}) for head \`${ci.headSha}\`.`,
        ...(ci.source === 'actions-runs'
          ? [
              '',
              '_Verdict read from the `actions/runs` fallback (the `check-runs` readout '
                + 'was unavailable — the token likely lacks `checks:read`); third-party '
                + 'required checks are not visible to this readout._',
            ]
          : []),
        '',
        'The workflow is paused with `waiting-for:ci` + `agent:paused`. Re-run '
          + 'validation (CI, tests, PR ready-marking, and the merge gate) by '
          + 'adding `completed:ci` once CI is green.',
      ].join('\n');
      let alreadyPosted = false;
      try {
        const existing = await context.github.getIssueComments(
          context.item.owner,
          context.item.repo,
          context.item.issueNumber,
        );
        const latest = existing[existing.length - 1];
        alreadyPosted =
          latest !== undefined
          && latest.body.includes(CI_PAUSE_MARKER)
          && latest.body.includes(fingerprint);
      } catch (error) {
        this.logger.warn(
          { error: String(error), phase },
          'CI pause comment dedupe read failed — posting without dedupe',
        );
      }
      if (alreadyPosted) {
        this.logger.info(
          { phase, ciVerdict: ci.verdict, headSha: ci.headSha },
          'CI pause comment already posted for this verdict/sha — skipping re-post',
        );
      } else {
        await context.github.addIssueComment(
          context.item.owner,
          context.item.repo,
          context.item.issueNumber,
          body,
        );
      }
    } catch (error) {
      this.logger.warn(
        { error: String(error), phase },
        '#1157: failed to post CI merge-readiness pause comment — continuing to pause',
      );
    }

    result.gateHit = { gateLabel: 'waiting-for:ci', reason };
    const ciTs = phaseTimestamps.get(phase);
    if (ciTs) ciTs.completedAt = new Date().toISOString();
    await stageCommentManager.updateStageComment({
      stage,
      status: 'in_progress',
      phases: this.buildPhaseProgress(sequence, startIndex, currentIndex, phaseTimestamps, 'complete'),
      startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      prUrl: context.prUrl,
    });
    return { results, completed: false, lastPhase: phase, gateHit: true };
  }

  /**
   * Build a phase progress array for stage comment updates.
   *
   * Uses actual tracked timestamps per phase rather than a single synthetic timestamp.
   */
  private buildPhaseProgress(
    sequence: WorkflowPhase[],
    startIndex: number,
    currentIndex: number,
    phaseTimestamps: Map<WorkflowPhase, { startedAt: string; completedAt?: string }>,
    currentStatus: 'in_progress' | 'complete' | 'error' = 'in_progress',
  ): { phase: WorkflowPhase; status: 'pending' | 'in_progress' | 'complete' | 'error'; startedAt?: string; completedAt?: string }[] {
    return sequence.map((phase, idx) => {
      const ts = phaseTimestamps.get(phase);

      if (idx < startIndex) {
        // Before the start — already complete from a prior run (no tracked timestamp)
        return { phase, status: 'complete' as const };
      }
      if (idx < currentIndex) {
        // Earlier in this run — completed
        return { phase, status: 'complete' as const, startedAt: ts?.startedAt, completedAt: ts?.completedAt };
      }
      if (idx === currentIndex) {
        // Current phase
        return { phase, status: currentStatus, startedAt: ts?.startedAt, ...(currentStatus === 'complete' || currentStatus === 'error' ? { completedAt: ts?.completedAt } : {}) };
      }
      // Future phase
      return { phase, status: 'pending' as const };
    });
  }
}
