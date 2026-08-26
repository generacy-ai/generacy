import type { GitHubClient, LinkedPR } from '@generacy-ai/workflow-engine';
import { resolveIssueBranch, simpleGit } from '@generacy-ai/workflow-engine';
import type { WorkflowPhase, Logger, CommitResult } from './types.js';
import { parsePRUrl } from './linked-pr-url-parser.js';
import { evaluatePushGuard, type PushGuardDecision } from './push-guard.js';
import { defaultRemoteBranchExists } from './repo-checkout.js';
import { isEngineSidecar, isCollapsedEngineStateDir } from './product-diff.js';
import { readReviewArtifact, setMarkedReadyByEngine } from './review-artifact.js';

/**
 * Internal discriminated union returned by `commitAndPush`. Loosely mirrors
 * the wire shape historically returned as a bare `boolean` (true = pushed or
 * unchanged-no-refusal; false = nothing to commit) with an added `refused`
 * variant so `commitPushAndEnsurePr` can distinguish "guard refused" from
 * "nothing to commit". PR #1052 review Findings 2+3.
 */
type CommitAndPushOutcome =
  | { kind: 'pushed' }
  | { kind: 'no-changes' }
  | { kind: 'refused'; refusal: Extract<PushGuardDecision, { kind: 'refuse' }> };

/**
 * Manages draft PR creation and git commit/push operations between workflow phases.
 *
 * After each phase completes:
 * 1. Commits any changed files with a phase-specific message
 * 2. Pushes the branch to the remote
 * 3. Creates a draft PR (if one doesn't already exist)
 *
 * This ensures the PR is created early (after specify) and updated incrementally.
 */
export class PrManager {
  private prUrl: string | undefined;
  private prNumber: number | undefined;

  /**
   * #1125 FR-006: true iff the engine currently holds this PR ready-for-review
   * (set by `markReadyForReview`, cleared by `convertToDraftIfEngineMarkedReady`
   * on a successful convert). Gates the draft conversion so the engine never
   * demotes a PR a human marked ready. In-memory — a worker restart resets it to
   * false, which is safe over-conservatism (we simply won't convert to draft).
   */
  private markedReadyByEngine = false;

  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
    /**
     * #1051 FR-002: cwd for the pre-push guard's `git ls-remote` call.
     * Optional so existing tests (which construct PrManager without a checkout
     * path) keep passing — the default helper falls back to the process cwd.
     */
    private readonly checkoutPath?: string,
    /**
     * #1156 FR-006: workflowId for the review sidecar so `markedReadyByEngine`
     * can be persisted / reconstructed across runs. Optional — best-effort
     * persistence is skipped when either this or `checkoutPath` is absent.
     */
    private readonly workflowId?: string,
  ) {}

  /**
   * Get the current PR URL (if a PR has been created).
   */
  getPrUrl(): string | undefined {
    return this.prUrl;
  }

  /**
   * Returns the number of the PR this manager tracks, or undefined if none
   * has been created (or resolved via findPRForBranch) yet.
   */
  getPrNumber(): number | undefined {
    return this.prNumber;
  }

  /**
   * Commit any changes, push to remote, and ensure a draft PR exists.
   *
   * Safe to call after every phase — handles "nothing to commit" and
   * "PR already exists" gracefully.
   *
   * PR #1052 review Finding 2: when the pre-push guard refuses (merged/closed
   * PR, or open PR with a missing branch), this method MUST short-circuit
   * BEFORE `ensureDraftPr()` — otherwise the guard blocks the push but
   * `ensureDraftPr` still opens a duplicate `Closes #N` PR against the
   * merged/deleted branch, defeating the guard entirely. The returned
   * `CommitResult.pushRefused` field is the signal for the phase loop to
   * abort the workflow (see Finding 3).
   *
   * @returns A `CommitResult` — `pushRefused` is present iff the guard
   * refused; when absent the phase completed normally.
   */
  async commitPushAndEnsurePr(phase: WorkflowPhase, options?: { message?: string }): Promise<CommitResult> {
    const outcome = await this.commitAndPush(phase, options?.message);
    if (outcome.kind === 'refused') {
      // Do NOT call ensureDraftPr — otherwise the guard blocks the push but
      // the very next line opens a duplicate PR that claims `Closes #N`
      // against a merged/deleted branch (PR #1052 review Finding 2).
      const { reason, prNumber, branch, owner, repo, issueNumber } = outcome.refusal;
      return {
        hasChanges: false,
        pushRefused: { reason, prNumber, branch, owner, repo, issueNumber },
      };
    }
    const prUrl = await this.ensureDraftPr();
    return { ...(prUrl !== undefined ? { prUrl } : {}), hasChanges: outcome.kind === 'pushed' };
  }

  /**
   * Commit any uncommitted changes and push to the remote.
   *
   * Handles both cases: uncommitted changes (we commit them) and changes the
   * phase already committed directly (detected via unpushed commits).
   *
   * PR #1052 review Finding 3: returns a discriminated `CommitAndPushOutcome`
   * so the caller can distinguish "guard refused" (`refused`) from
   * "nothing to push" (`no-changes`) and "pushed successfully" (`pushed`).
   * A bare boolean return would collapse `refused` into `no-changes`, causing
   * the phase loop to mark the phase complete and advance — with zero commits
   * having reached origin.
   */
  private async commitAndPush(
    phase: WorkflowPhase,
    customMessage?: string,
  ): Promise<CommitAndPushOutcome> {
    try {
      let committed = false;

      // #1162 FR-001: stage only genuine product paths, never engine sidecars.
      // Replaces the unscoped `git add -A` that committed `.generacy/review-*`
      // and `pause-context-*` bookkeeping into product PR diffs. A phase whose
      // only pending change is a sidecar leaves `toStage` empty and produces no
      // commit (no empty commits).
      //
      // `status.staged` is included so an index-only product change (staged with
      // no further working-tree diff — e.g. an implement agent that ran
      // `git add`, or a prior interrupted commitAndPush) is not stranded. The
      // commit is then made with an explicit pathspec of exactly `toStage`, so a
      // sidecar that some other actor pre-staged into the index is never folded
      // into the commit by the whole-index `git commit` — the "never committed"
      // guarantee (FR-001/SC-001) holds even against a dirty index.
      //
      // A collapsed `.generacy/` directory entry (a status backend that does not
      // expand untracked directories) is skipped too: its contents are opaque to
      // the sidecar filter, and staging it would commit every sidecar at once.
      const status = await this.github.getStatus();
      const { staged = [], unstaged = [], untracked = [] } = status;
      const toStage = [...new Set([...staged, ...unstaged, ...untracked])].filter(
        (p) => !isEngineSidecar(p) && !isCollapsedEngineStateDir(p),
      );
      if (toStage.length > 0) {
        // Stage first so untracked members of `toStage` are known to git before
        // the pathspec commit (a bare `git commit -- <untracked>` would fail).
        await this.github.stageFiles(toStage);

        // Commit with a phase-specific message, scoped to the filtered pathspec.
        const message = customMessage ?? `chore(speckit): complete ${phase} phase for #${this.issueNumber}`;
        const commitResult = await this.github.commit(message, toStage);
        this.logger.info(
          { phase, sha: commitResult.sha, files: commitResult.files_committed.length },
          'Committed phase changes',
        );
        committed = true;
      }

      // Check for unpushed commits (the phase may have committed directly)
      const branch = await this.github.getCurrentBranch();
      const remoteExists = await this.github.branchExists(branch, true).catch(() => false);
      let unpushedCount: number;
      if (remoteExists) {
        const unpushed = await this.github.getCommitsBetween(`origin/${branch}`, branch).catch(() => []);
        unpushedCount = unpushed.length;
      } else {
        // Remote branch doesn't exist yet — any local commits are unpushed
        const defaultBranch = await this.github.getDefaultBranch();
        const localCommits = await this.github.getCommitsBetween(`origin/${defaultBranch}`, branch).catch(() => []);
        unpushedCount = localCommits.length;
      }
      const hasUnpushed = unpushedCount > 0;

      if (!committed && !hasUnpushed) {
        this.logger.debug({ phase }, 'No changes to commit or push after phase');
        return { kind: 'no-changes' };
      }

      if (hasUnpushed) {
        if (!committed) {
          this.logger.info(
            { phase, unpushedCount },
            'Phase committed its own changes — pushing to remote',
          );
        }

        // #1051 FR-002/003: pre-push guard. Refuses the push when the PR has
        // already merged/closed or the remote branch is missing — prevents a
        // re-entering worker from resurrecting a deleted branch and opening a
        // duplicate PR that claims `Closes #<already-closed>`. Applies to both
        // uncommitted-then-committed changes and phase-committed changes since
        // both funnel through this push site.
        const decision = await evaluatePushGuard({
          owner: this.owner,
          repo: this.repo,
          issueNumber: this.issueNumber,
          branch,
          github: this.github,
          git: {
            remoteBranchExists: (b) => defaultRemoteBranchExists(b, this.checkoutPath),
          },
        });
        if (decision.kind === 'refuse') {
          await this.handlePushRefused(decision);
          // PR #1052 review Finding 3: propagate the refusal so the caller
          // (`commitPushAndEnsurePr` → phase loop) can distinguish this from
          // a legitimate "nothing to commit" and abort the workflow.
          return { kind: 'refused', refusal: decision };
        }

        // Push to remote (set upstream on first push)
        const pushResult = await this.github.push('origin', branch, true);
        this.logger.info(
          { phase, ref: pushResult.ref, remote: pushResult.remote },
          'Pushed phase changes to remote',
        );
      }

      return { kind: 'pushed' };
    } catch (error) {
      // Log but don't fail the workflow — commit/push is best-effort between phases
      this.logger.warn(
        { phase, error: String(error) },
        'Failed to commit/push after phase (non-fatal)',
      );
      return { kind: 'no-changes' };
    }
  }

  /**
   * Ensure a draft PR exists for the current branch.
   *
   * On first call: creates a new draft PR linked to the issue.
   * On subsequent calls: returns the existing PR URL (no-op).
   *
   * @returns The PR URL, or undefined if creation failed.
   */
  /**
   * Best-effort #1043 dedup probe.
   *
   * If an `<N>-*` branch other than the current checkout already has an OPEN
   * PR, adopt that PR (record its number/URL and return the URL so the caller
   * stops). A PR-less canonical branch is IGNORED (Q2=A) — logged and skipped
   * so the caller proceeds to create a PR on the current branch.
   *
   * Every failure is swallowed (logged as non-fatal) so this probe can never
   * disrupt normal PR creation or leave `this.prNumber` unset. In particular,
   * `resolveIssueBranch`/`simpleGit` may be unavailable or a GitHub client
   * method may be missing (e.g. in tests) — that must not abort PR creation.
   *
   * @returns the adopted PR URL if a canonical open PR was adopted, else undefined.
   */
  private async tryAdoptCanonicalPr(branch: string): Promise<string | undefined> {
    try {
      const canonical = await resolveIssueBranch({
        issueNumber: this.issueNumber,
        owner: this.owner,
        repo: this.repo,
        github: this.github,
        git: simpleGit(),
        logger: this.logger,
      });

      if (canonical && canonical.branchName !== branch) {
        const adoptedPr = await this.github.findPRForBranch(
          this.owner,
          this.repo,
          canonical.branchName,
        );
        if (adoptedPr) {
          this.prNumber = adoptedPr.number;
          this.prUrl = `https://github.com/${this.owner}/${this.repo}/pull/${adoptedPr.number}`;
          this.logger.info(
            {
              event: 'workflow-reentry-branch-mismatch',
              issueNumber: this.issueNumber,
              currentBranch: branch,
              canonicalBranch: canonical.branchName,
              source: canonical.source,
              anchoringPrNumber: canonical.anchoringPrNumber,
              action: 'adopted',
            },
            'workflow-reentry-branch-mismatch',
          );
          return this.prUrl;
        }
        // #1043 Finding 1 (Q2=A): the resolver reported a canonical `<N>-*`
        // branch that differs from our checkout but has NO open PR. A PR-less
        // `<N>-*` branch must be IGNORED — it is not canonical. Do NOT no-op
        // (that permanently stalls PR creation for the real work branch); the
        // caller falls through to create a PR on the current branch.
        this.logger.info(
          {
            event: 'workflow-reentry-branch-mismatch',
            issueNumber: this.issueNumber,
            currentBranch: branch,
            canonicalBranch: canonical.branchName,
            source: canonical.source,
            anchoringPrNumber: canonical.anchoringPrNumber,
            action: 'ignored-prless-canonical',
          },
          'workflow-reentry-branch-mismatch',
        );
      }
    } catch (error) {
      // Best-effort: a dedup failure must NEVER abort PR creation.
      this.logger.warn(
        { issueNumber: this.issueNumber, error: String(error) },
        'workflow-reentry dedup probe failed (non-fatal) — proceeding with normal PR creation',
      );
    }
    return undefined;
  }

  private async ensureDraftPr(): Promise<string | undefined> {
    // If we already know the PR URL, return it
    if (this.prUrl) {
      return this.prUrl;
    }

    try {
      const branch = await this.github.getCurrentBranch();

      // #1043 defense-in-depth: before opening a new PR, check whether an
      // `<N>-*` branch/PR already anchors this issue. Prevents pr-manager
      // from being the sole dedup site when createFeature's resolver
      // callback is not wired.
      //
      // This probe is best-effort — `tryAdoptCanonicalPr` isolates it in its
      // own try/catch so that ANY failure (resolver throw, an unavailable
      // client method such as a mock without `listOpenPullRequests`, or a git
      // error) falls through to the normal PR-creation path below rather than
      // aborting it. Without this isolation a dedup failure would leave
      // `this.prNumber` unset and silently break the markReadyForReview-on-
      // completion flow (#1043 review follow-up).
      const adoptedUrl = await this.tryAdoptCanonicalPr(branch);
      if (adoptedUrl) {
        return adoptedUrl;
      }

      // Check if a PR already exists for this branch
      const existingPr = await this.github.findPRForBranch(this.owner, this.repo, branch);
      if (existingPr) {
        this.prNumber = existingPr.number;
        this.prUrl = `https://github.com/${this.owner}/${this.repo}/pull/${existingPr.number}`;

        this.logger.info(
          { prNumber: existingPr.number, prUrl: this.prUrl },
          'Found existing PR for branch',
        );
        return this.prUrl;
      }

      // Create a new draft PR
      const defaultBranch = await this.github.getDefaultBranch();
      const pr = await this.github.createPullRequest(this.owner, this.repo, {
        title: `feat: #${this.issueNumber} ${branch}`,
        body: `## Summary\n\nCloses #${this.issueNumber}\n\n---\n*Draft PR created by Generacy orchestrator. Updated after each workflow phase.*\n`,
        head: branch,
        base: defaultBranch,
        draft: true,
      });

      this.prNumber = pr.number;
      this.prUrl = `https://github.com/${this.owner}/${this.repo}/pull/${pr.number}`;
      this.logger.info(
        { prNumber: pr.number, prUrl: this.prUrl },
        'Created draft PR',
      );

      return this.prUrl;
    } catch (error) {
      // Log but don't fail the workflow — PR creation is best-effort
      this.logger.warn(
        { error: String(error) },
        'Failed to ensure draft PR (non-fatal)',
      );
      return undefined;
    }
  }

  /**
   * #1051 FR-003: react to a `refuse` decision from the pre-push guard.
   *
   * Mirrors the same warn shape as `PrFeedbackHandler.handlePushRefused` so a
   * grep for `event: 'push-refused'` reveals every refusal site (T061). Best-
   * effort label mutation: `agent:in-progress` cleared unconditionally,
   * `agent:error` added only when the linked issue is still open.
   *
   * Deliberately typed via `Extract<PushGuardDecision, ...>` (PR #1052 review
   * Finding 1) so a new refusal reason on the guard cannot desynchronize this
   * signature. `pr-lookup-failed` is treated the same as the other reasons on
   * purpose — a safety gate that could not verify state is still a refusal an
   * operator needs to see (`agent:error` on an open issue), and the reason
   * literal in the warn log lets triage distinguish "we could not determine
   * safety" from "we determined it is unsafe".
   */
  private async handlePushRefused(
    decision: Extract<PushGuardDecision, { kind: 'refuse' }>,
  ): Promise<void> {
    const { reason, prNumber, branch, owner, repo, issueNumber } = decision;
    this.logger.warn(
      { event: 'push-refused', reason, prNumber, branch, owner, repo, issueNumber },
      'Refusing push — PR state or remote branch state indicates a resurrection or duplicate-PR attempt',
    );

    let issueState: 'open' | 'closed' = 'open';
    try {
      const issue = await this.github.getIssue(owner, repo, issueNumber);
      issueState = issue.state;
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePushRefused: failed to read issue state — assuming open',
      );
    }

    try {
      await this.github.removeLabels(owner, repo, issueNumber, ['agent:in-progress']);
    } catch (error) {
      this.logger.warn(
        { error: String(error), issueNumber },
        'handlePushRefused: failed to remove agent:in-progress — non-fatal',
      );
    }

    if (issueState === 'open') {
      try {
        await this.github.addLabels(owner, repo, issueNumber, ['agent:error']);
      } catch (error) {
        this.logger.warn(
          { error: String(error), issueNumber },
          'handlePushRefused: failed to add agent:error — non-fatal',
        );
      }
    }
  }

  /**
   * Mark the draft PR as ready for review.
   *
   * Should be called after the workflow completes successfully (all phases done).
   * If no PR exists or the PR number is unknown, this is a no-op.
   *
   * When linkedPRs are provided, also flips each sibling draft to ready-for-review
   * via `gh pr ready`. Best-effort: logs warnings on failure, doesn't fail workflow.
   *
   * The underlying GitHub API call is idempotent — calling it on a non-draft PR
   * has no effect.
   */
  async markReadyForReview(linkedPRs?: LinkedPR[]): Promise<void> {
    if (!this.prNumber) {
      this.logger.debug('No PR number available — skipping markReadyForReview');
      return;
    }

    try {
      await this.github.markPRReady(this.owner, this.repo, this.prNumber);
      // #1125 FR-006: record that the engine holds this PR ready so a later
      // remediate entry can convert it back to draft (and never touch a PR a
      // human marked ready).
      this.markedReadyByEngine = true;
      // #1156 FR-006: also persist to the sidecar so a re-entry in a NEW run
      // (fresh process → in-memory flag reset) can still reconstruct it.
      // Best-effort — skipped when either path component is absent.
      if (this.checkoutPath && this.workflowId) {
        await setMarkedReadyByEngine(this.checkoutPath, this.workflowId, true);
      }
      this.logger.info(
        { prNumber: this.prNumber, prUrl: this.prUrl },
        'Marked PR as ready for review',
      );
    } catch (error) {
      // Log but don't fail the workflow — marking ready is best-effort
      this.logger.warn(
        { prNumber: this.prNumber, error: String(error) },
        'Failed to mark PR as ready for review (non-fatal)',
      );
    }

    // Flip sibling PRs to ready-for-review (idempotent, best-effort)
    await this.markSiblingsReadyForReview(linkedPRs);
  }

  /**
   * #1125 FR-006: convert the PR (and each linked sibling) back to draft when
   * the engine is entering a remediate round — but ONLY if the engine itself
   * marked it ready. A no-op when `markedReadyByEngine` is false, so a PR a
   * human marked ready is never demoted.
   *
   * Best-effort per PR: `convertPullRequestToDraft` is idempotent (short-circuits
   * when already draft) and every failure warns without throwing. Clears the
   * flag on a successful primary convert so a subsequent remediate entry is a
   * no-op until the engine marks ready again (FR-008).
   */
  async convertToDraftIfEngineMarkedReady(linkedPRs?: LinkedPR[]): Promise<void> {
    // #1156 FR-006: when the in-memory flag is false (e.g. a fresh process on a
    // cross-run re-entry) reconstruct it from the sidecar. Only the engine's own
    // `markReadyForReview` ever writes the flag `true`, so this can never demote
    // a PR a human marked ready (FR-007).
    let engineMarkedReady = this.markedReadyByEngine;
    if (!engineMarkedReady && this.checkoutPath && this.workflowId) {
      const artifact = await readReviewArtifact(this.checkoutPath, this.workflowId);
      engineMarkedReady = artifact?.markedReadyByEngine ?? false;
    }

    if (!engineMarkedReady) {
      this.logger.debug('Engine did not mark this PR ready — skipping convert-to-draft');
      return;
    }
    if (!this.prNumber) {
      this.logger.debug('No PR number available — skipping convert-to-draft');
      return;
    }

    try {
      await this.github.convertPullRequestToDraft(this.owner, this.repo, this.prNumber);
      this.markedReadyByEngine = false;
      // #1156 FR-006: clear the persisted flag too so a later remediate entry is
      // a no-op until the engine marks ready again.
      if (this.checkoutPath && this.workflowId) {
        await setMarkedReadyByEngine(this.checkoutPath, this.workflowId, false);
      }
      this.logger.info(
        { prNumber: this.prNumber, prUrl: this.prUrl },
        'Converted PR back to draft for remediation',
      );
    } catch (error) {
      this.logger.warn(
        { prNumber: this.prNumber, error: String(error) },
        'Failed to convert PR to draft (non-fatal)',
      );
    }

    // Convert linked siblings too (idempotent, best-effort).
    if (!linkedPRs || linkedPRs.length === 0) return;
    for (const pr of linkedPRs) {
      const parsed = parsePRUrl(pr.url);
      if (!parsed) {
        this.logger.warn({ url: pr.url }, 'Could not parse linked PR URL — skipping convert-to-draft');
        continue;
      }
      try {
        await this.github.convertPullRequestToDraft(parsed.owner, parsed.repo, parsed.number);
        this.logger.info(
          { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number },
          'Converted sibling PR back to draft for remediation',
        );
      } catch (error) {
        this.logger.warn(
          { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number, error: String(error) },
          'Failed to convert sibling PR to draft (non-fatal)',
        );
      }
    }
  }

  /**
   * Mark all linked sibling PRs as ready for review.
   * Best-effort: logs warnings on failure, doesn't fail the workflow.
   * Idempotent — `gh pr ready` is a no-op on non-draft PRs.
   */
  async markSiblingsReadyForReview(linkedPRs?: LinkedPR[]): Promise<void> {
    if (!linkedPRs || linkedPRs.length === 0) return;

    for (const pr of linkedPRs) {
      const parsed = parsePRUrl(pr.url);
      if (!parsed) {
        this.logger.warn({ url: pr.url }, 'Could not parse linked PR URL — skipping ready-for-review');
        continue;
      }

      try {
        await this.github.markPRReady(parsed.owner, parsed.repo, parsed.number);
        this.logger.info(
          { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number },
          'Marked sibling PR as ready for review',
        );
      } catch (error) {
        this.logger.warn(
          { repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number, error: String(error) },
          'Failed to mark sibling PR as ready for review (non-fatal)',
        );
      }
    }
  }
}
