import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { StageType, StageCommentData, Logger } from './types.js';
import { STAGE_MARKERS } from './types.js';

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

    return lines.join('\n');
  }
}
