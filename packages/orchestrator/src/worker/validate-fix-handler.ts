import { executeCommand, wrapUntrustedData } from '@generacy-ai/workflow-engine';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ValidateFixIntent } from '@generacy-ai/generacy-plugin-claude-code';
import type { QueueItem } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import { resolveAgentForPhase } from './config.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import { buildLaunchCredentials } from './credentials-helper.js';
import { warnIfEffortDropped } from './effort-mechanism-check.js';
import { hashValidationEvidence } from './evidence-hash.js';

/**
 * Evidence handed to the adapter from PhaseLoop's routed validate-failure
 * branch.
 */
export interface ValidateFailureEvidence {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
 * Thin remediate adapter (#1129).
 *
 * Interim `remediate` behavior for validate-origin remediations while
 * `remediate` is still a stub. Invoked from PhaseLoop's remediate seam when a
 * `pendingValidateRemediation` is set (never from a base-advance `catch`).
 *
 * Reduced surface (FR-005): the one-attempt-per-evidence-hash cap, the
 * `resumeReason === 'base-advance'` coupling, and ownership of `failed:*`
 * escalation labels are all gone — the phase loop owns escalation now. On any
 * failure the adapter throws; the phase loop logs and continues (the
 * subsequent delta-scoped review + validate re-run, or the fingerprint
 * backstop, is the terminal safety net).
 *
 * Preserved (FR-010): the fix prompt built from validate evidence, the commit,
 * the sibling-owned-file enumeration, and the revert-on-overlap guard.
 *
 * See specs/1129-context-worker-validate-fix/contracts/thin-adapter-contract.md.
 */
export class ValidateFixHandler {
  constructor(
    private readonly config: WorkerConfig,
    private readonly agentLauncher: AgentLauncher,
    private readonly logger: Logger,
  ) {}

  /**
   * Run one fix attempt against the given failing evidence. On any failure —
   * including a sibling-owned-file overlap — this throws; the phase loop's
   * remediate-seam wrapper (T007) logs and continues.
   */
  async handle(
    item: QueueItem,
    checkoutPath: string,
    ctx: ValidateFixContext,
    evidence: ValidateFailureEvidence,
    github: GitHubClient,
    workflowName: string,
  ): Promise<void> {
    const { owner, repo, issueNumber } = item;
    const { prNumber, baseBranch } = ctx;

    // Compute the evidence hash + structured extract. The hash is metadata for
    // the intent + commit message; the extract enriches the fix prompt. It is
    // no longer a dedupe gate (FR-005).
    const { hash, extract } = hashValidationEvidence(evidence.stdout);

    this.logger.info(
      { owner, repo, issueNumber, prNumber, evidenceHash: hash, failureCount: extract.failures.length },
      'ValidateFixHandler: entering fix attempt',
    );

    // Sibling-owned file collection (best-effort).
    const siblingFiles = await this.collectSiblingOwnedFiles(
      github, owner, repo, baseBranch, prNumber,
    );

    // Build prompt.
    const prompt = this.buildFixPrompt(evidence, extract, siblingFiles, hash, prNumber);

    // Spawn.
    // #1095: bind to `implement` phase for `{ provider, model, effort }` — same
    // rule pr-feedback-handler.ts uses (fixer paths revise the code the
    // implement phase produced). `workflowName === 'unknown'` naturally degrades
    // through `agents.default` tiers to the container CLI ambient default.
    const { provider, model, effort } = resolveAgentForPhase(this.config, workflowName, 'implement');

    const intent: ValidateFixIntent = {
      kind: 'validate-fix',
      prNumber,
      prompt,
      evidenceHash: hash,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };

    // #1095 review Finding 2: spawn-time drop warning (Q3=D) — the fixer
    // launches via `agentLauncher` directly, not `CliSpawner`, so it must
    // emit its own warning to satisfy the "once per spawn" invariant.
    warnIfEffortDropped(this.logger, {
      provider,
      effort,
      context: { handler: 'validate-fix', owner, repo, issueNumber, prNumber },
    });

    const handle = await this.agentLauncher.launch({
      intent,
      cwd: checkoutPath,
      env: {},
      credentials: buildLaunchCredentials(this.config.credentialRole),
      provider,
    });
    // Drain streams so the child doesn't stall on back-pressure.
    handle.process.stdout?.on('data', () => undefined);
    handle.process.stderr?.on('data', () => undefined);
    const exitCode = await handle.process.exitPromise;

    this.logger.info(
      { owner, repo, issueNumber, prNumber, evidenceHash: hash, exitCode },
      'ValidateFixHandler: agent exit',
    );

    // commit → sibling-overlap guard → push.
    const commitMessage = `validate-fix: ${hash.slice(0, 12)}`;
    const committed = await this.commitChanges(github, checkoutPath, commitMessage);

    if (!committed.hasChanges) {
      // No diff — nothing to push. The subsequent review + validate re-run (or
      // the fingerprint backstop on repeated-identical failure) is the safety
      // net; the adapter is best-effort.
      this.logger.info(
        { owner, repo, issueNumber, prNumber, evidenceHash: hash },
        'ValidateFixHandler: no changes to commit',
      );
      return;
    }

    // Post-hoc sibling-overlap guard on the just-committed change set. If the
    // fix touched a file owned by a sibling PR, revert the commit and throw —
    // never push a sibling-overlapping change.
    if (siblingFiles.length > 0 && committed.committedFiles.length > 0) {
      const overlap = committed.committedFiles.filter((f) => siblingFiles.includes(f));
      if (overlap.length > 0) {
        this.logger.warn(
          { owner, repo, issueNumber, prNumber, overlap, evidenceHash: hash },
          'ValidateFixHandler: sibling-file overlap — reverting commit',
        );
        try {
          await this.revertLocalCommit(checkoutPath);
        } catch (err) {
          this.logger.warn(
            { err: String(err), checkoutPath },
            'ValidateFixHandler: revertLocalCommit failed — continuing',
          );
        }
        throw new Error(
          `validate-fix produced a sibling-owned-file overlap (${overlap.join(', ')}); reverted, not pushed`,
        );
      }
    }

    // Push.
    await this.pushChanges(github);
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

    return `You are running an autonomous fix attempt for a failing validate check on PR #${prNumber}.

The failing validate command produced the following output:

${fencedEvidence}

Structured failure identity (SHA-256 hash: ${hash}):

${failureLines}
${siblingBlock}
**Instructions:**
1. Read the validate output above and address every failure it reports.
2. Do NOT create any file that appears in the "Do not create" list — those files belong to sibling PRs and will merge cleanly through their own branches.
3. Focus on this PR's own scope — do not touch unrelated code.
4. Your changes will be automatically committed and pushed on this branch.

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
}
