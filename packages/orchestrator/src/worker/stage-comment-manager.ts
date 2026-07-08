import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { StageType, StageCommentData, Logger, FailureAlertData } from './types.js';
import { STAGE_MARKERS, FAILURE_ALERT_MARKER_PREFIX } from './types.js';

/**
 * Stage display titles with emoji prefixes
 */
const STAGE_TITLES: Record<StageType, string> = {
  specification: '\u{1F4CB} Specification',
  planning: '\u{1F4D0} Planning',
  implementation: '\u{1F528} Implementation',
};

/**
 * Status icons for phase and stage statuses
 */
const STATUS_ICONS: Record<string, string> = {
  pending: '\u{23F3}',
  in_progress: '\u{1F504}',
  complete: '\u{2705}',
  error: '\u{274C}',
};

/**
 * Human-readable status labels
 */
const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In Progress',
  complete: 'Complete',
  error: 'Error',
};

/**
 * Manages stage comments on GitHub issues using HTML markers
 * to find, create, and update stage progress comments.
 */
export class StageCommentManager {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Find an existing stage comment or create a new one.
   *
   * Searches issue comments for the HTML marker corresponding to the stage.
   * If found, returns its comment ID. Otherwise, creates a new comment
   * with the marker and initial content, then returns the new ID.
   */
  async findOrCreateStageComment(stage: StageType): Promise<number> {
    const marker = STAGE_MARKERS[stage];
    // #842 audit: whitelist — reads only for STAGE_MARKERS to dedupe bot's
    // own stage-comment postings; body content is never surfaced to an agent.
    const comments = await this.github.getIssueComments(
      this.owner,
      this.repo,
      this.issueNumber,
    );

    // Look for an existing comment with the stage marker
    for (const comment of comments) {
      if (comment.body.includes(marker)) {
        this.logger.debug(
          { stage, commentId: comment.id },
          'Found existing stage comment',
        );
        return comment.id;
      }
    }

    // No existing comment found — create a new one
    const title = STAGE_TITLES[stage];
    const initialBody = `${marker}\n## ${title} Stage\n\n**Status**: ${STATUS_ICONS['pending']} Pending\n`;

    const created = await this.github.addIssueComment(
      this.owner,
      this.repo,
      this.issueNumber,
      initialBody,
    );

    this.logger.info(
      { stage, commentId: created.id },
      'Created new stage comment',
    );

    return created.id;
  }

  /**
   * Update an existing stage comment with new progress data.
   *
   * Finds or creates the comment, renders the updated body,
   * and updates it via the GitHub API.
   */
  async updateStageComment(data: StageCommentData): Promise<void> {
    const commentId = await this.findOrCreateStageComment(data.stage);
    const body = this.renderStageComment(data);

    await this.github.updateComment(
      this.owner,
      this.repo,
      commentId,
      body,
    );

    this.logger.debug(
      { stage: data.stage, commentId },
      'Updated stage comment',
    );
  }

  /**
   * Render a stage comment body with a progress table and summary.
   */
  private renderStageComment(data: StageCommentData): string {
    const marker = STAGE_MARKERS[data.stage];
    const title = STAGE_TITLES[data.stage];
    const statusIcon = STATUS_ICONS[data.status] ?? STATUS_ICONS['in_progress'];
    const statusLabel = STATUS_LABELS[data.status] ?? data.status;

    const lines: string[] = [
      marker,
      `## ${title} Stage`,
      '',
      '| Phase | Status | Started | Completed |',
      '|-------|--------|---------|-----------|',
    ];

    for (const phase of data.phases) {
      const phaseIcon = STATUS_ICONS[phase.status] ?? STATUS_ICONS['pending'];
      const started = phase.startedAt ?? '\u{2014}';
      const completed = phase.completedAt ?? '\u{2014}';
      lines.push(
        `| ${phase.phase} | ${phaseIcon} ${phase.status} | ${started} | ${completed} |`,
      );
    }

    lines.push('');
    lines.push(`**Status**: ${statusIcon} ${statusLabel}`);
    lines.push(`**Started**: ${data.startedAt}`);

    if (data.completedAt) {
      lines.push(`**Completed**: ${data.completedAt}`);
    }

    if (data.prUrl) {
      lines.push(`**PR**: ${data.prUrl}`);
    }

    lines.push('');

    if (data.status === 'error') {
      if (data.errorEvidence) {
        this.appendEvidenceBlock(lines, data.errorEvidence);
      } else {
        this.logger.warn(
          { stage: data.stage },
          'Stage comment error status without errorEvidence — omitting evidence block',
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Append the failure-evidence block to the rendered comment lines.
   *
   * See specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md
   * for the exact byte layout. The block is placed after the existing summary
   * metadata (below a horizontal-rule separator), so bytes above the `---`
   * remain identical to the pre-fix output (invariant 1).
   */
  private appendEvidenceBlock(
    lines: string[],
    evidence: NonNullable<StageCommentData['errorEvidence']>,
  ): void {
    // Neutralize any triple-backtick sequence inside stderrTail so it cannot
    // break out of our fenced block. Insert U+200B (ZWSP) between the first two
    // backticks of every 3-backtick run.
    const safeStderr = evidence.stderrTail.replace(/```/g, '`​``');
    const lineCount = evidence.stderrTail.split('\n').length;

    lines.push('---');
    lines.push(`**Failed command**: \`${evidence.command}\``);
    lines.push(`**Exit**: ${evidence.exitDescriptor}`);
    lines.push('');
    lines.push(`<details><summary>stderr (last ${lineCount} lines)</summary>`);
    lines.push('');
    lines.push('```text');
    lines.push(safeStderr);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  }

  /**
   * Post a bottom-of-thread failure-alert comment on the issue.
   *
   * On a terminal-failure occurrence, `phase-loop.ts` calls this to surface a
   * fresh comment (fires a GitHub notification) carrying a summary line + a
   * collapsible <details> block with the verbatim buildErrorEvidence output.
   *
   * Deduplicated via marker scan: a matching `(stage, runId)` marker in an
   * existing comment suppresses re-posting. See
   * specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md.
   */
  async postFailureAlert(data: FailureAlertData): Promise<void> {
    const marker = `${FAILURE_ALERT_MARKER_PREFIX}${data.stage}:${data.runId} -->`;

    const comments = await this.github.getIssueComments(
      this.owner,
      this.repo,
      this.issueNumber,
    );

    const existing = comments.find((c) => c.body.includes(marker));
    if (existing) {
      this.logger.info(
        { stage: data.stage, runId: data.runId, existingCommentId: existing.id },
        'Failure alert already exists — suppressing duplicate post',
      );
      return;
    }

    const body = this.renderFailureAlert(marker, data);
    const created = await this.github.addIssueComment(
      this.owner,
      this.repo,
      this.issueNumber,
      body,
    );

    this.logger.info(
      { stage: data.stage, runId: data.runId, commentId: created.id },
      'Posted failure alert comment',
    );
  }

  /**
   * Render the failure-alert body per contract §"Alert body layout".
   * Byte-exact: marker line, summary line, blank, <details> wrapper, fenced
   * text block with backtick-neutralized stderr, closing </details>.
   */
  private renderFailureAlert(marker: string, data: FailureAlertData): string {
    const evidence = data.evidence;
    const lineCount = evidence.stderrTail.split('\n').length;
    // Same ZWSP substitution used by appendEvidenceBlock — neutralize any
    // ``` sequence inside stderrTail so the outer fenced block stays closed.
    const safeStderr = evidence.stderrTail.replace(/```/g, '`​``');
    return [
      marker,
      `❌ **${data.phase} failed** — \`${evidence.command}\` ${evidence.exitDescriptor}.`,
      '',
      `<details><summary>stderr (last ${lineCount} lines)</summary>`,
      '',
      '```text',
      safeStderr,
      '```',
      '',
      '</details>',
    ].join('\n');
  }
}
