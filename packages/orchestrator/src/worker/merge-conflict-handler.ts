/**
 * #898 T011 — Bounded merge-conflict resolution handler.
 *
 * Shape template: `pr-feedback-handler.ts`.
 * Contract: `specs/898-found-during-cockpit-v1/contracts/handler-contract.md`.
 *
 * Termination discipline: the "one autonomous attempt" is the agent-CLI
 * invocation itself (Q4 → D). Pre-agent git/network flakes get bounded
 * 3× retry budgets; the agent invocation runs at most once; post-agent
 * `git push` gets 3× retry on network errors only (non-fast-forward
 * rejections do NOT retry — they escalate to `blocked:stuck-merge-conflicts`).
 *
 * On success: `completed:merge-conflicts` label added, `waiting-for:merge-conflicts`
 * and `agent:paused` removed. On failure: `blocked:stuck-merge-conflicts`
 * added, `waiting-for:merge-conflicts` preserved, evidence block emitted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createGitHubClient,
  type GitHubClient,
} from '@generacy-ai/workflow-engine';
import type { MergeConflictIntent } from '@generacy-ai/generacy-plugin-claude-code';

/**
 * Local `PullRequest` alias derived from `GitHubClient.listOpenPullRequests`.
 * Avoids depending on the deep types barrel — the shape is stable enough
 * for the fields we read (`number`, `base.ref`, `head.ref`, `body`).
 */
type PullRequest = Awaited<ReturnType<GitHubClient['listOpenPullRequests']>>[number];
import type { QueueItem, ResolveMergeConflictsMetadata } from '../types/index.js';
import type { Logger } from './types.js';
import type { WorkerConfig } from './config.js';
import type { SSEEventEmitter } from './output-capture.js';
import type { AgentLauncher } from '../launcher/agent-launcher.js';
import { OutputCapture } from './output-capture.js';
import { RepoCheckout } from './repo-checkout.js';
import { PrLinker, type PrLinkInput } from './pr-linker.js';
import { buildMergeConflictPrompt } from './merge-conflict-prompt.js';
import { buildLaunchCredentials } from './credentials-helper.js';

const execFileAsync = promisify(execFile);

/** Label added on the success path. */
const COMPLETED_MERGE_CONFLICTS_LABEL = 'completed:merge-conflicts';
/** Label that must be present + removed on success. */
const WAITING_FOR_MERGE_CONFLICTS_LABEL = 'waiting-for:merge-conflicts';
/** Label removed on success alongside `waiting-for:merge-conflicts`. */
const AGENT_PAUSED_LABEL = 'agent:paused';
/** Label added when the one autonomous attempt fails to resolve the conflict. */
const BLOCKED_STUCK_MERGE_CONFLICTS_LABEL = 'blocked:stuck-merge-conflicts';

/** Retry backoffs used by every 3× retry-classed operation. */
const RETRY_BACKOFFS_MS = [250, 500, 1000];

/**
 * Evidence emitted when the agent-CLI attempt fails to produce a conflict-
 * free committed merge (FR-009).
 */
export interface BlockedStuckMergeConflictsEvidence {
  /** Paths that still had conflict markers after the agent-CLI attempt. */
  unresolvedPaths: string[];
  /**
   * Paths the agent successfully resolved (staged, no markers).
   * Empty if the agent produced no diff at all.
   */
  partiallyResolvedPaths: string[];
  /** Base ref that was being merged. */
  baseRef: string;
  /** Short SHA of the branch tip at attempt time. */
  branchTipSha: string;
  /** ISO timestamp of the attempt. */
  attemptedAt: string;
  /** Optional short human-readable reason (e.g., "no linked PR"). */
  reason?: string;
}

/**
 * Handles the `resolve-merge-conflicts` command per #898.
 *
 * Processing flow (see `handler-contract.md` §"Flow"):
 *   1-3. Parse item, create GitHub client, resolve PR via PrLinker.
 *   4.   switchBranch with 3× retry.
 *   5.   resolveBaseBranch (reuses #864 helper).
 *   6-7. fetch + merge origin/<base> with 3× retry. No-op merge → immediate success.
 *   8.   Enumerate conflicted paths.
 *   9-10.Enumerate open PRs targeting same base, cache file lists.
 *   11.  Build MergeConflictIntent prompt via buildMergeConflictPrompt.
 *   12.  agentLauncher.launch EXACTLY ONCE.
 *   13.  Success predicate: no MERGE_HEAD, no unresolved paths, no conflict markers.
 *   14.  git push origin <branch> with 3× retry (network only; NFF is a hard fail).
 *   15.  On success: apply completed:merge-conflicts + remove waiting-for + agent:paused.
 *   17.  On block: apply blocked:stuck-merge-conflicts, leave waiting-for in place,
 *        emit evidence block, return normally.
 */
export class MergeConflictHandler {
  private readonly repoCheckout: RepoCheckout;
  private readonly prLinker: PrLinker;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    private readonly agentLauncher: AgentLauncher,
    private readonly sseEmitter?: SSEEventEmitter,
  ) {
    this.repoCheckout = new RepoCheckout(config.workspaceDir, logger);
    this.prLinker = new PrLinker(logger);
  }

  /**
   * Process a merge-conflict resolution task.
   */
  async handle(item: QueueItem, checkoutPath: string): Promise<void> {
    const { owner, repo, issueNumber } = item;
    const workflowId = `${owner}/${repo}#${issueNumber}`;
    const metadata = item.metadata as ResolveMergeConflictsMetadata | undefined;

    this.logger.info(
      { owner, repo, issueNumber, checkoutPath, hint: metadata },
      'MergeConflictHandler: starting',
    );

    const github = createGitHubClient(checkoutPath);

    // Steps 1-3: resolve PR + branch.
    let pr: PullRequest | null = null;
    try {
      // Try `context.linkedPRs` semantics via `findPRForBranch` on the item's
      // implicit branch. But the handler's cleaner path is to enumerate open
      // PRs and match the issue number via PrLinker.
      const openPRs = await this.retry(
        () => github.listOpenPullRequests(owner, repo),
        'listOpenPullRequests',
      );
      for (const candidate of openPRs) {
        const linkInput: PrLinkInput = {
          number: candidate.number,
          body: candidate.body ?? '',
          head: { ref: candidate.head.ref },
        };
        const link = await this.prLinker.linkPrToIssue(github, owner, repo, linkInput);
        if (link && link.issueNumber === issueNumber) {
          pr = candidate;
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        { err: String(error), owner, repo, issueNumber },
        'MergeConflictHandler: failed to enumerate PRs — proceeding to no-PR disposition',
      );
    }

    if (!pr) {
      await this.applyBlockedDisposition(
        github,
        owner,
        repo,
        issueNumber,
        {
          unresolvedPaths: [],
          partiallyResolvedPaths: [],
          baseRef: '',
          branchTipSha: '',
          attemptedAt: new Date().toISOString(),
          reason: 'no linked PR',
        },
      );
      return;
    }

    const branchName = pr.head.ref;

    // Step 4: switch to the PR branch with 3× retry.
    try {
      await this.retry(
        () => this.repoCheckout.switchBranch(checkoutPath, branchName),
        'switchBranch',
      );
    } catch (error) {
      this.logger.error(
        { err: String(error), branchName, checkoutPath },
        'MergeConflictHandler: failed to switch to PR branch after retries',
      );
      throw new Error(`Failed to switch to branch ${branchName}: ${String(error)}`);
    }

    // Step 5: resolve base branch (`origin/<name>`) directly from the linked PR.
    const baseRef = `origin/${pr.base.ref}`;
    const baseName = pr.base.ref;

    // Step 6: fresh fetch of the base ref.
    try {
      await this.retry(
        () => execFileAsync('git', ['fetch', 'origin', baseName], { cwd: checkoutPath }),
        'git fetch origin ' + baseName,
      );
    } catch (error) {
      this.logger.error(
        { err: String(error), baseRef },
        'MergeConflictHandler: git fetch origin exhausted retries',
      );
      throw new Error(`Failed to fetch ${baseRef}: ${String(error)}`);
    }

    // Guard: no-op merge — the branch is already up-to-date with base. Clear
    // labels and return success without spending the agent attempt.
    // `git merge-base --is-ancestor <base> HEAD` exit 0 => base is ancestor of HEAD.
    if (await this.baseIsAncestor(checkoutPath, baseRef)) {
      this.logger.info(
        { owner, repo, issueNumber, baseRef, branch: branchName },
        'MergeConflictHandler: no-op merge (branch already up to date) — clearing labels',
      );
      await this.applySuccessDisposition(github, owner, repo, issueNumber);
      return;
    }

    // Step 7: git merge origin/<base>. Retry ONLY on env classes (index.lock,
    // RPC). Conflict output is the expected forward path.
    let mergeExitedCleanly = false;
    let mergeAttemptError: unknown;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length + 1; attempt++) {
      try {
        await execFileAsync('git', ['merge', '--no-ff', baseRef], { cwd: checkoutPath });
        mergeExitedCleanly = true;
        break;
      } catch (err) {
        mergeAttemptError = err;
        const stderr = (err as { stderr?: string } | undefined)?.stderr ?? '';
        const looksLikeConflict = /conflict/i.test(stderr);
        if (looksLikeConflict) {
          // Expected — CONTINUE to conflicted-path enumeration.
          break;
        }
        const looksTransient = this.isTransientGitError(err);
        if (!looksTransient || attempt >= RETRY_BACKOFFS_MS.length) {
          // Non-transient non-conflict git failure. Fall through to guard below.
          break;
        }
        const backoff = RETRY_BACKOFFS_MS[attempt]!;
        this.logger.warn(
          { err: String(err), attempt: attempt + 1, backoffMs: backoff },
          'MergeConflictHandler: transient git merge failure — retrying',
        );
        await this.sleep(backoff);
      }
    }

    if (mergeExitedCleanly) {
      // The merge command reported success but we thought there'd be a
      // conflict. Push the resulting merge commit and finish.
      await this.pushAndSucceed(github, checkoutPath, branchName, owner, repo, issueNumber, baseRef);
      return;
    }

    // Step 8: enumerate conflicted paths after the failed merge.
    let conflictedPaths: string[] = [];
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: checkoutPath },
      );
      conflictedPaths = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      this.logger.warn(
        { err: String(err) },
        'MergeConflictHandler: could not enumerate conflicted paths after merge failure',
      );
    }

    if (conflictedPaths.length === 0) {
      // Non-conflict merge failure — treat as blocked with the raw error text
      // as the reason. Abort the merge so we leave a clean tree.
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: checkoutPath });
      } catch {
        // best-effort
      }
      await this.applyBlockedDisposition(github, owner, repo, issueNumber, {
        unresolvedPaths: [],
        partiallyResolvedPaths: [],
        baseRef,
        branchTipSha: await this.getBranchTipSha(checkoutPath),
        attemptedAt: new Date().toISOString(),
        reason: `git merge failed without conflicts: ${String(mergeAttemptError ?? 'unknown')}`,
      });
      return;
    }

    // Steps 9-10: enumerate open PRs targeting the same base and cache their
    // file lists. FR-005 / Q3 → A: same-base-in-repo enumeration is the
    // load-bearing input, NOT `context.linkedPRs`.
    const siblingFileMap = await this.enumerateSiblingFileMap(
      github,
      owner,
      repo,
      baseName,
      pr.number,
    );

    // Step 11: derive sibling-owned paths for the prompt.
    const siblingOwnedPaths = conflictedPaths.filter((p) => siblingFileMap.has(p));

    // Step 12: build the prompt + invoke the agent CLI EXACTLY ONCE.
    const prompt = buildMergeConflictPrompt({
      conflictedPaths,
      siblingOwnedPaths,
      baseRef,
      branch: branchName,
    });

    this.logger.info(
      {
        owner, repo, issueNumber,
        conflictedPathCount: conflictedPaths.length,
        siblingOwnedPathCount: siblingOwnedPaths.length,
        siblingPrFileMapSize: siblingFileMap.size,
      },
      'MergeConflictHandler: invoking agent CLI (single attempt) for conflict resolution',
    );

    const cliSucceeded = await this.spawnAgentForConflict(
      checkoutPath,
      prompt,
      workflowId,
      issueNumber,
    );

    // Step 13: post-agent verification — success predicate.
    const verification = await this.verifyMergeResolved(checkoutPath);
    if (!cliSucceeded || !verification.ok) {
      this.logger.warn(
        {
          owner, repo, issueNumber,
          cliSucceeded,
          verification,
        },
        'MergeConflictHandler: agent attempt did not produce conflict-free merge — blocked disposition',
      );

      const partiallyResolvedPaths = conflictedPaths.filter(
        (p) => !verification.unresolvedPaths.includes(p),
      );

      // Abort the in-progress merge so we don't leave the working tree half-
      // resolved — the operator will take the manual remedy from Ship 1.
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: checkoutPath });
      } catch {
        // best-effort
      }

      await this.applyBlockedDisposition(github, owner, repo, issueNumber, {
        unresolvedPaths: verification.unresolvedPaths,
        partiallyResolvedPaths,
        baseRef,
        branchTipSha: await this.getBranchTipSha(checkoutPath),
        attemptedAt: new Date().toISOString(),
      });
      return;
    }

    // Step 14: push the merge commit.
    await this.pushAndSucceed(github, checkoutPath, branchName, owner, repo, issueNumber, baseRef);
  }

  /**
   * Enumerate open PRs targeting `baseName` (excluding the target issue's own PR)
   * and build a Map<path, prNumber[]> of files each sibling PR touches.
   *
   * Uses `gh pr view <number> --json files` per sibling (call site is bounded
   * to the poll cycle, per handler-contract §Observability). Missing files
   * data is treated as an empty set.
   */
  private async enumerateSiblingFileMap(
    github: GitHubClient,
    owner: string,
    repo: string,
    baseName: string,
    selfPrNumber: number,
  ): Promise<Map<string, number[]>> {
    const fileMap = new Map<string, number[]>();
    let siblings: PullRequest[];
    try {
      const openPRs = await github.listOpenPullRequests(owner, repo);
      siblings = openPRs.filter(
        (p) => p.number !== selfPrNumber && p.base.ref === baseName,
      );
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, baseName },
        'MergeConflictHandler: sibling PR enumeration failed — proceeding without sibling scope guard',
      );
      return fileMap;
    }

    for (const sibling of siblings) {
      try {
        const files = await this.fetchPrFiles(owner, repo, sibling.number);
        for (const file of files) {
          const existing = fileMap.get(file) ?? [];
          existing.push(sibling.number);
          fileMap.set(file, existing);
        }
      } catch (err) {
        this.logger.warn(
          { err: String(err), siblingPrNumber: sibling.number },
          'MergeConflictHandler: failed to fetch sibling PR files — omitting from scope guard',
        );
      }
    }

    this.logger.debug(
      { siblingCount: siblings.length, fileCount: fileMap.size },
      'MergeConflictHandler: sibling file map built',
    );

    return fileMap;
  }

  /**
   * `gh pr view <number> --json files` on the local checkout. Called
   * per-sibling; failures are non-fatal (the scope guard degrades to
   * "no siblings" for that PR, which is safer than throwing).
   */
  private async fetchPrFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr', 'view', String(prNumber),
        '--repo', `${owner}/${repo}`,
        '--json', 'files',
        '--jq', '.files[].path',
      ],
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Success predicate (handler-contract §"Success predicate"):
   *   - `.git/MERGE_HEAD` does NOT exist (merge is complete)
   *   - `git diff --name-only --diff-filter=U` is empty (no unresolved paths)
   *   - No file in the tree contains `<<<<<<< ` at line-start (belt & suspenders)
   */
  private async verifyMergeResolved(
    checkoutPath: string,
  ): Promise<{ ok: boolean; unresolvedPaths: string[] }> {
    const unresolvedPaths: string[] = [];

    if (existsSync(join(checkoutPath, '.git', 'MERGE_HEAD'))) {
      return { ok: false, unresolvedPaths: await this.listUnresolvedPaths(checkoutPath) };
    }

    const gitUnmerged = await this.listUnresolvedPaths(checkoutPath);
    if (gitUnmerged.length > 0) {
      return { ok: false, unresolvedPaths: gitUnmerged };
    }

    // Belt & suspenders: scan tracked files for the conflict marker sentinel.
    // Small-scale enumeration — cheaper than launching `git grep` which
    // requires the index to be in a specific state.
    try {
      const markerCandidates = await this.scanForConflictMarkers(checkoutPath);
      if (markerCandidates.length > 0) {
        return { ok: false, unresolvedPaths: markerCandidates };
      }
    } catch (err) {
      this.logger.debug(
        { err: String(err) },
        'MergeConflictHandler: conflict-marker scan failed — treating as no markers',
      );
    }

    return { ok: true, unresolvedPaths };
  }

  private async listUnresolvedPaths(checkoutPath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: checkoutPath },
      );
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Best-effort scan for the `<<<<<<< ` conflict marker at line start across
   * tracked files. Uses `git ls-files` to enumerate, then reads each file
   * synchronously (bounded — small worker workloads).
   */
  private async scanForConflictMarkers(checkoutPath: string): Promise<string[]> {
    let tracked: string[];
    try {
      const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: checkoutPath });
      tracked = stdout.split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }

    const hits: string[] = [];
    for (const rel of tracked) {
      const abs = join(checkoutPath, rel);
      try {
        const contents = readFileSync(abs, 'utf-8');
        if (contents.startsWith('<<<<<<< ') || contents.includes('\n<<<<<<< ')) {
          hits.push(rel);
        }
      } catch {
        // Skip binary/unreadable files silently.
      }
    }
    return hits;
  }

  /**
   * `git push origin <branch>` with 3× retry on transient network errors.
   * Non-fast-forward rejection does NOT retry — it escalates to blocked.
   * On success, applies the completed labels and returns.
   */
  private async pushAndSucceed(
    github: GitHubClient,
    checkoutPath: string,
    branchName: string,
    owner: string,
    repo: string,
    issueNumber: number,
    baseRef: string,
  ): Promise<void> {
    let pushed = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length + 1; attempt++) {
      try {
        await execFileAsync('git', ['push', 'origin', branchName], { cwd: checkoutPath });
        pushed = true;
        break;
      } catch (err) {
        lastErr = err;
        if (this.isNonFastForward(err)) {
          this.logger.warn(
            { err: String(err), branchName },
            'MergeConflictHandler: push rejected non-fast-forward — blocked disposition',
          );
          break;
        }
        if (!this.isTransientNetworkError(err) || attempt >= RETRY_BACKOFFS_MS.length) {
          break;
        }
        const backoff = RETRY_BACKOFFS_MS[attempt]!;
        this.logger.warn(
          { err: String(err), attempt: attempt + 1, backoffMs: backoff },
          'MergeConflictHandler: transient push failure — retrying',
        );
        await this.sleep(backoff);
      }
    }

    if (!pushed) {
      this.logger.error(
        { err: String(lastErr), branchName, owner, repo, issueNumber },
        'MergeConflictHandler: git push exhausted — blocked disposition',
      );
      await this.applyBlockedDisposition(github, owner, repo, issueNumber, {
        unresolvedPaths: [],
        partiallyResolvedPaths: [],
        baseRef,
        branchTipSha: await this.getBranchTipSha(checkoutPath),
        attemptedAt: new Date().toISOString(),
        reason: `git push failed: ${String(lastErr ?? 'unknown')}`,
      });
      return;
    }

    await this.applySuccessDisposition(github, owner, repo, issueNumber);
  }

  private async applySuccessDisposition(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [COMPLETED_MERGE_CONFLICTS_LABEL]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), issueNumber, label: COMPLETED_MERGE_CONFLICTS_LABEL },
        'MergeConflictHandler: failed to add completed:merge-conflicts label',
      );
    }
    try {
      await github.removeLabels(owner, repo, issueNumber, [
        WAITING_FOR_MERGE_CONFLICTS_LABEL,
        AGENT_PAUSED_LABEL,
      ]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), issueNumber },
        'MergeConflictHandler: failed to remove waiting-for:merge-conflicts / agent:paused',
      );
    }
    this.logger.info(
      { owner, repo, issueNumber, disposition: 'success' },
      'MergeConflictHandler: conflict resolved and pushed',
    );
  }

  private async applyBlockedDisposition(
    github: GitHubClient,
    owner: string,
    repo: string,
    issueNumber: number,
    evidence: BlockedStuckMergeConflictsEvidence,
  ): Promise<void> {
    try {
      await github.addLabels(owner, repo, issueNumber, [BLOCKED_STUCK_MERGE_CONFLICTS_LABEL]);
    } catch (err) {
      this.logger.warn(
        { err: String(err), issueNumber, label: BLOCKED_STUCK_MERGE_CONFLICTS_LABEL },
        'MergeConflictHandler: failed to add blocked:stuck-merge-conflicts label',
      );
    }
    // Evidence emission: for now this is a structured warn log line; the
    // stage-comment integration lives at the phase-loop pause site and is
    // already load-bearing (Ship 1's self-describing remedy). Rendering
    // evidence into the stage comment from the handler process requires the
    // StageCommentManager wiring, which the handler does not construct.
    this.logger.warn(
      {
        owner, repo, issueNumber,
        evidence,
        disposition: 'blocked',
      },
      'MergeConflictHandler: blocked:stuck-merge-conflicts — evidence recorded',
    );
  }

  /**
   * Spawn the agent CLI with a MergeConflictIntent. Runs at most once
   * (Q4 → D). Returns true if the CLI exited 0, false otherwise.
   */
  private async spawnAgentForConflict(
    checkoutPath: string,
    prompt: string,
    workflowId: string,
    issueNumber: number,
  ): Promise<boolean> {
    let child;
    try {
      const handle = await this.agentLauncher.launch({
        intent: {
          kind: 'merge-conflict',
          issueNumber,
          prompt,
        } as MergeConflictIntent,
        cwd: checkoutPath,
        env: {},
        credentials: buildLaunchCredentials(this.config.credentialRole),
      });
      child = handle.process;
    } catch (err) {
      this.logger.error(
        { err: String(err), cwd: checkoutPath },
        'MergeConflictHandler: failed to spawn agent CLI process',
      );
      return false;
    }

    const outputCapture = new OutputCapture(workflowId, this.logger, this.sseEmitter);

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer | string) => {
        outputCapture.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    if (child.stderr) {
      let stderrBuffer = '';
      child.stderr.on('data', (data: Buffer | string) => {
        stderrBuffer += typeof data === 'string' ? data : data.toString('utf-8');
      });
      child.exitPromise.finally(() => {
        if (stderrBuffer.trim()) {
          this.logger.debug(
            { stderr: stderrBuffer.trim() },
            'MergeConflictHandler: agent CLI stderr',
          );
        }
      });
    }

    const timeoutMs = this.config.phaseTimeoutMs;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      this.logger.warn(
        { pid: child.pid, timeoutMs },
        'MergeConflictHandler: agent CLI timed out — sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.pid) {
          child.kill('SIGKILL');
        }
      }, this.config.shutdownGracePeriodMs);
    }, timeoutMs);

    try {
      const exitCode = await child.exitPromise;
      clearTimeout(timeoutTimer);
      outputCapture.flush();
      if (timedOut) return false;
      return exitCode === 0;
    } catch (err) {
      clearTimeout(timeoutTimer);
      this.logger.error(
        { err: String(err), timedOut },
        'MergeConflictHandler: error waiting for agent CLI',
      );
      return false;
    }
  }

  private async retry<T>(op: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length + 1; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (!this.isTransientGitError(err) || attempt >= RETRY_BACKOFFS_MS.length) {
          break;
        }
        const backoff = RETRY_BACKOFFS_MS[attempt]!;
        this.logger.warn(
          { err: String(err), attempt: attempt + 1, label, backoffMs: backoff },
          'MergeConflictHandler: transient error — retrying',
        );
        await this.sleep(backoff);
      }
    }
    throw lastErr;
  }

  private isTransientGitError(err: unknown): boolean {
    const s = String((err as Error)?.message ?? err ?? '');
    return (
      s.includes('ECONNRESET') ||
      s.includes('ETIMEDOUT') ||
      s.includes('index.lock') ||
      s.includes('RPC failed') ||
      s.includes('early EOF')
    );
  }

  private isTransientNetworkError(err: unknown): boolean {
    const s = String((err as Error)?.message ?? err ?? '');
    return (
      s.includes('ECONNRESET') ||
      s.includes('ETIMEDOUT') ||
      s.includes('RPC failed') ||
      s.includes('early EOF') ||
      s.includes('remote end hung up')
    );
  }

  private isNonFastForward(err: unknown): boolean {
    const s = String((err as { stderr?: string } | undefined)?.stderr ?? '') +
      String((err as Error)?.message ?? '');
    return /non-fast-forward|!\s*\[rejected\]/i.test(s);
  }

  private async baseIsAncestor(checkoutPath: string, baseRef: string): Promise<boolean> {
    try {
      await execFileAsync(
        'git',
        ['merge-base', '--is-ancestor', baseRef, 'HEAD'],
        { cwd: checkoutPath },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async getBranchTipSha(checkoutPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: checkoutPath,
      });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
