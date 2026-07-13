import { executeCommand, wrapUntrustedData } from '@generacy-ai/workflow-engine';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ValidateFixIntent } from '@generacy-ai/generacy-plugin-claude-code';
import type { QueueItem, PhaseTracker } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import { buildLaunchCredentials } from './credentials-helper.js';
import { hashValidationEvidence } from './evidence-hash.js';

/** Label added when the fix cycle cannot advance (#883-style termination). */
const BLOCKED_STUCK_VALIDATE_FIX_LABEL = 'blocked:stuck-validate-fix';
const AGENT_ERROR_LABEL = 'agent:error';
const AGENT_IN_PROGRESS_LABEL = 'agent:in-progress';
const FAILED_VALIDATE_LABEL = 'failed:validate';
const PHASE_VALIDATE_LABEL = 'phase:validate';

/**
 * Evidence handed to the handler from PhaseLoop's validate `catch` block.
 */
export interface ValidateFailureEvidence {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Structured launch context. Carries the linked PR number and base branch —
 * both needed by the sibling-file overlap check.
 */
export interface ValidateFixContext {
  prNumber: number;
  baseBranch: string;
}

/**
 * Optional relay event emitter. Fire-and-forget; must never throw.
 * Consumer: cluster.validate-fix channel on the cloud side (out of scope).
 */
export type ValidateFixEventEmitter = (channel: string, payload: unknown) => void;

/**
 * Bounded validate-fix cycle (#892).
 *
 * Invoked ONLY from PhaseLoop's validate `catch` block, gated by
 * `WorkerContext.resumeReason === 'base-advance'` (D7 ordering invariant).
 * First-time reds still route through `LabelManager.onError('validate')`.
 *
 * Contract: exactly one autonomous attempt per distinct evidence hash. Same
 * hash → escalation via `blocked:stuck-validate-fix`. No-diff after spawn →
 * escalation. Sibling-owned file overlap post-commit → revert + escalation.
 *
 * See specs/892-found-during-cockpit-v1/contracts/validate-fix-handler.md.
 */
export class ValidateFixHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly agentLauncher: AgentLauncher,
    private readonly phaseTracker: PhaseTracker,
    private readonly logger: Logger,
    private readonly emitEvent?: ValidateFixEventEmitter,
  ) {}

  /**
   * Run one bounded fix attempt against the given failing evidence.
   * Never throws — all failures land as `emit` + label side effects.
   */
  async handle(
    item: QueueItem,
    checkoutPath: string,
    ctx: ValidateFixContext,
    evidence: ValidateFailureEvidence,
    github: GitHubClient,
  ): Promise<void> {
    const { owner, repo, issueNumber } = item;
    const { prNumber, baseBranch } = ctx;

    // 1. Hash evidence.
    let hash: string;
    let extract;
    try {
      const result = hashValidationEvidence(evidence.stdout);
      hash = result.hash;
      extract = result.extract;
    } catch (err) {
      this.logger.error(
        { err: String(err), owner, repo, issueNumber, prNumber },
        'ValidateFixHandler: hashValidationEvidence threw — escalating (safe default)',
      );
      await this.escalate(github, owner, repo, issueNumber, {
        status: 'escalated', reason: 'hash-error',
        evidenceHash: 'unknown', prNumber, owner, repo, issueNumber,
      });
      return;
    }

    const dupKey = `validate-fix:${hash}`;

    this.logger.info(
      { owner, repo, issueNumber, prNumber, evidenceHash: hash, failureCount: extract.failures.length },
      'ValidateFixHandler: entering fix cycle',
    );

    // 2. Dedupe check.
    if (await this.phaseTracker.isDuplicate(owner, repo, issueNumber, dupKey)) {
      await this.escalate(github, owner, repo, issueNumber, {
        status: 'escalated', reason: 'duplicate-evidence-hash',
        evidenceHash: hash, prNumber, owner, repo, issueNumber,
      });
      return;
    }

    // 3. Mark processed BEFORE spawn. If the spawn crashes mid-flight, the
    //    key remaining prevents a duplicate attempt on cluster restart.
    await this.phaseTracker.markProcessed(owner, repo, issueNumber, dupKey);

    // 4. Sibling-owned file collection (best-effort).
    const siblingFiles = await this.collectSiblingOwnedFiles(
      github, owner, repo, baseBranch, prNumber,
    );

    // 5. Build prompt.
    const prompt = this.buildFixPrompt(evidence, extract, siblingFiles, hash, prNumber);

    // 6. Spawn.
    const intent: ValidateFixIntent = {
      kind: 'validate-fix',
      prNumber,
      prompt,
      evidenceHash: hash,
    };

    let exitCode: number | null;
    try {
      const handle = await this.agentLauncher.launch({
        intent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
      });
      // Drain streams so the child doesn't stall on back-pressure.
      handle.process.stdout?.on('data', () => undefined);
      handle.process.stderr?.on('data', () => undefined);
      exitCode = await handle.process.exitPromise;
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber, prNumber, evidenceHash: hash },
        'ValidateFixHandler: launcher.launch threw',
      );
      await this.applyStuckLabel(github, owner, repo, issueNumber);
      this.safeEmit('cluster.validate-fix', {
        status: 'blocked', reason: 'launch-error',
        evidenceHash: hash, owner, repo, issueNumber, prNumber,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    this.logger.info(
      { owner, repo, issueNumber, prNumber, evidenceHash: hash, exitCode },
      'ValidateFixHandler: agent exit',
    );

    // 7. commit → sibling-overlap check → push.
    const commitMessage = `validate-fix: ${hash.slice(0, 12)}`;
    let committed;
    try {
      committed = await this.commitChanges(github, checkoutPath, commitMessage);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber, prNumber, evidenceHash: hash },
        'ValidateFixHandler: commit failed',
      );
      await this.applyStuckLabel(github, owner, repo, issueNumber);
      this.safeEmit('cluster.validate-fix', {
        status: 'blocked', reason: 'commit-error',
        evidenceHash: hash, owner, repo, issueNumber, prNumber,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!committed.hasChanges) {
      // #883 termination discipline — no-diff.
      await this.applyStuckLabel(github, owner, repo, issueNumber);
      this.safeEmit('cluster.validate-fix', {
        status: 'blocked', reason: 'no-diff',
        evidenceHash: hash, owner, repo, issueNumber, prNumber,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Post-hoc sibling-overlap check on the just-committed change set.
    if (siblingFiles.length > 0 && committed.committedFiles.length > 0) {
      const overlap = committed.committedFiles.filter((f) => siblingFiles.includes(f));
      if (overlap.length > 0) {
        this.logger.warn(
          { owner, repo, issueNumber, prNumber, overlap, evidenceHash: hash },
          'ValidateFixHandler: sibling-file overlap — reverting commit and escalating',
        );
        try {
          await this.revertLocalCommit(checkoutPath);
        } catch (err) {
          this.logger.warn(
            { err: String(err), checkoutPath },
            'ValidateFixHandler: revertLocalCommit failed — continuing',
          );
        }
        await this.applyStuckLabel(github, owner, repo, issueNumber);
        this.safeEmit('cluster.validate-fix', {
          status: 'blocked', reason: 'sibling-file-overlap',
          evidenceHash: hash, overlappingFiles: overlap,
          owner, repo, issueNumber, prNumber,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // Push.
    try {
      await this.pushChanges(github);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber, prNumber, evidenceHash: hash },
        'ValidateFixHandler: push failed',
      );
      await this.applyStuckLabel(github, owner, repo, issueNumber);
      this.safeEmit('cluster.validate-fix', {
        status: 'blocked', reason: 'push-error',
        evidenceHash: hash, owner, repo, issueNumber, prNumber,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    this.safeEmit('cluster.validate-fix', {
      status: 'attempted',
      evidenceHash: hash,
      owner, repo, issueNumber, prNumber,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Escalation gate — same red already spent our one attempt (or hash errored).
   * Adds `blocked:stuck-validate-fix` + `agent:error`, removes in-progress
   * labels, emits event. Best-effort throughout.
   */
  private async escalate(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [
        BLOCKED_STUCK_VALIDATE_FIX_LABEL,
        AGENT_ERROR_LABEL,
      ]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'ValidateFixHandler: addLabels (escalation) failed — non-fatal',
      );
    }
    try {
      await github.removeLabels(owner, repo, issueNumber, [
        PHASE_VALIDATE_LABEL,
        AGENT_IN_PROGRESS_LABEL,
      ]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'ValidateFixHandler: removeLabels (escalation) failed — non-fatal',
      );
    }
    this.safeEmit('cluster.validate-fix', {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  private async applyStuckLabel(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [BLOCKED_STUCK_VALIDATE_FIX_LABEL]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'ValidateFixHandler: addLabels (stuck) failed — non-fatal',
      );
    }
    // The failed:validate label re-applies via LabelManager.onError('validate')
    // on the caller's path — we don't touch it here.
    void FAILED_VALIDATE_LABEL;
  }

  /**
   * Enumerate open PRs to the same base branch and union their diff file lists.
   * Best-effort per sibling — one throw does not abort the whole collection.
   */
  private async collectSiblingOwnedFiles(
    github: GitHubClient,
    owner: string,
    repo: string,
    baseBranch: string,
    ownPrNumber: number,
  ): Promise<string[]> {
    let openPRs;
    try {
      openPRs = await github.listOpenPullRequests(owner, repo);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, baseBranch },
        'ValidateFixHandler: listOpenPullRequests failed — proceeding with empty sibling list',
      );
      return [];
    }
    const siblings = openPRs.filter(
      (pr) => pr.base?.ref === baseBranch && pr.number !== ownPrNumber,
    );
    const files: string[] = [];
    for (const pr of siblings) {
      try {
        const names = await github.prDiffNames(`${owner}/${repo}`, pr.number);
        files.push(...names);
      } catch (err) {
        this.logger.warn(
          { err: String(err), owner, repo, siblingPr: pr.number },
          'ValidateFixHandler: sibling prDiffNames failed — partial list',
        );
      }
    }
    return [...new Set(files)];
  }

  /**
   * Build the fix prompt — includes full stdout evidence, structured extract,
   * do-not-create file list, and the identity hash.
   */
  private buildFixPrompt(
    evidence: ValidateFailureEvidence,
    extract: { failures: Array<{ id: string; firstError: string }> },
    siblingFiles: string[],
    hash: string,
    prNumber: number,
  ): string {
    const failureLines = extract.failures
      .map((f, i) => `Failure ${i + 1}: ${f.id} — ${f.firstError}`)
      .join('\n');
    const siblingBlock = siblingFiles.length > 0
      ? `\n\nDo not create these files — they belong to sibling PRs on the same base branch:\n${siblingFiles.map((f) => `  - ${f}`).join('\n')}\n`
      : '\n\n(No sibling PRs to the same base branch had recorded diffs.)\n';

    const fencedEvidence = wrapUntrustedData(
      evidence.stdout,
      `PR #${prNumber} validate stdout (exit ${evidence.exitCode})`,
    );

    return `You are running an autonomous fix attempt for a persistently-failing validate check on PR #${prNumber}.

The failing validate command produced the following output:

${fencedEvidence}

Structured failure identity (SHA-256 hash: ${hash}):

${failureLines}
${siblingBlock}
**Instructions:**
1. Read the validate output above and address every failure it reports.
2. Do NOT create any file that appears in the "Do not create" list — those files belong to sibling PRs and will merge cleanly through their own branches.
3. Focus on this PR's own scope — do not touch unrelated code.
4. Your changes will be automatically committed and pushed on this branch. You have exactly one attempt.

Proceed with the fix.`;
  }

  /**
   * Stage all changes, commit if any, and return whether anything was committed.
   * If committed, also returns the list of files in the new commit for the
   * sibling-overlap check.
   */
  private async commitChanges(
    github: GitHubClient,
    checkoutPath: string,
    message: string,
  ): Promise<{ hasChanges: boolean; committedFiles: string[] }> {
    const status = await github.getStatus();
    if (!status.has_changes) {
      return { hasChanges: false, committedFiles: [] };
    }
    await github.stageAll();
    const commit = await github.commit(message);

    // Prefer the commit result's files list; fall back to git diff HEAD~1..HEAD
    // for backends that don't populate files_committed.
    let committedFiles = commit.files_committed;
    if (!committedFiles || committedFiles.length === 0) {
      try {
        const result = await executeCommand(
          'git',
          ['diff', '--name-only', 'HEAD~1', 'HEAD'],
          { cwd: checkoutPath },
        );
        if (result.exitCode === 0) {
          committedFiles = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        }
      } catch {
        committedFiles = [];
      }
    }
    return { hasChanges: true, committedFiles: committedFiles ?? [] };
  }

  private async pushChanges(github: GitHubClient): Promise<void> {
    const branch = await github.getCurrentBranch();
    await github.push('origin', branch);
  }

  private async revertLocalCommit(checkoutPath: string): Promise<void> {
    const result = await executeCommand(
      'git',
      ['reset', '--hard', 'HEAD~1'],
      { cwd: checkoutPath },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git reset --hard HEAD~1 failed: ${result.stderr.trim()}`);
    }
  }

  private safeEmit(channel: string, payload: unknown): void {
    if (!this.emitEvent) return;
    try {
      this.emitEvent(channel, payload);
    } catch (err) {
      this.logger.warn(
        { err: String(err), channel },
        'ValidateFixHandler: emitEvent threw — swallowed',
      );
    }
  }
}
