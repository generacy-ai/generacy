/**
 * ReviewPoster — posts one COMMENT-event review per round and resolves threads
 * on re-review (#1125 T011–T013).
 *
 * Consumes a FindingsArtifact (the #1124 consuming contract) and turns it into a
 * single GitHub review submission via `GitHubClient.createReview`. Diffable
 * anchors become inline comments; everything else (absent or non-diffable
 * anchor) falls back to the review body so no finding is dropped (FR-002/002a).
 *
 * See contracts/review-poster.md.
 */
import type {
  GitHubClient,
  CreateReviewComment,
  CreateReviewInput,
  PullRequestFile,
  Review,
} from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';
import type { FindingsArtifact, ReviewFinding } from './review-findings-artifact.js';

/** Stable prefix for the once-per-review body marker (FR-003; #1130 exclusion). */
export const REVIEW_BODY_MARKER_PREFIX = 'generacy-engine-review';

/** Build the body marker for a given round: `<!-- generacy-engine-review round=<N> -->`. */
export function reviewBodyMarker(round: number): string {
  return `<!-- ${REVIEW_BODY_MARKER_PREFIX} round=${round} -->`;
}

/** Build the per-finding inline marker: `<!-- generacy-finding:<marker> -->`. */
export function findingMarker(marker: string): string {
  return `<!-- generacy-finding:${marker} -->`;
}

/**
 * Parse unified-diff hunk headers from each file's `patch` into the set of
 * RIGHT-side (post-change) line numbers that GitHub will accept an inline
 * comment on. A `@@ -a,b +c,d @@` header means added/context lines start at `c`
 * on the new side; each non-`-` (context or `+`) hunk line advances the counter.
 *
 * Files without a `patch` (binary / too-large) contribute no commentable lines.
 */
export function computeDiffableLines(files: PullRequestFile[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) continue;

    const lines = new Set<number>();
    let newLine = 0;
    let inHunk = false;

    for (const raw of file.patch.split('\n')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (header) {
        newLine = Number.parseInt(header[1]!, 10);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;

      if (raw.startsWith('-')) {
        // Deletion — only advances the OLD side; no RIGHT-side line here.
        continue;
      }
      if (raw.startsWith('+') || raw.startsWith(' ')) {
        lines.add(newLine);
        newLine += 1;
        continue;
      }
      // `\ No newline at end of file` or any other non-diff line: ignore.
    }

    result.set(file.filename, lines);
  }

  return result;
}

/**
 * Split findings into inline (diffable anchor) vs body. A finding is inline iff
 * it has an `anchor` whose `file` is in the diff AND whose `line` is a
 * commentable RIGHT-side line. Everything else falls back to the body so no
 * finding is dropped (FR-002a).
 */
export function partitionFindings(
  findings: ReviewFinding[],
  diffable: Map<string, Set<number>>,
): { inline: ReviewFinding[]; body: ReviewFinding[] } {
  const inline: ReviewFinding[] = [];
  const body: ReviewFinding[] = [];

  for (const finding of findings) {
    const anchor = finding.anchor;
    if (anchor && diffable.get(anchor.file)?.has(anchor.line)) {
      inline.push(finding);
    } else {
      body.push(finding);
    }
  }

  return { inline, body };
}

/** Human severity tag; advisory is rendered visually distinct from blocking (FR-004). */
function severityTag(finding: ReviewFinding): string {
  return finding.severity === 'advisory' ? '🔵 Advisory (non-blocking)' : '🔴 Blocking';
}

/**
 * Build the single review body: round marker + `Round <N>` header + each
 * body-fallback finding rendered with its severity tag. Body-fallback findings
 * reference their intended `file:line` when an anchor is present (FR-002a).
 */
export function buildReviewBody(bodyFindings: ReviewFinding[], round: number): string {
  const parts: string[] = [reviewBodyMarker(round), '', `## Engine review — Round ${round}`, ''];

  if (bodyFindings.length === 0) {
    parts.push('_No additional findings in the review body._');
  } else {
    for (const finding of bodyFindings) {
      const location = finding.anchor ? ` (\`${finding.anchor.file}:${finding.anchor.line}\`)` : '';
      parts.push(`- ${severityTag(finding)}${location}: ${finding.text}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build one inline review comment for a diffable finding. The comment body
 * carries the per-finding marker (cross-round match, FR-009), the finding text,
 * and a severity tag. `side` is hardcoded RIGHT — anchors are post-change lines.
 */
export function buildInlineComment(finding: ReviewFinding): CreateReviewComment {
  const anchor = finding.anchor!;
  return {
    path: anchor.file,
    line: anchor.line,
    side: 'RIGHT',
    body: `${findingMarker(finding.marker)}\n${severityTag(finding)}: ${finding.text}`,
  };
}

/** True iff a prior review body already carries this round's marker (FR-010 dedupe). */
export function isRoundAlreadyPosted(reviews: Review[], round: number): boolean {
  const marker = reviewBodyMarker(round);
  return reviews.some((r) => r.body.includes(marker));
}

export interface ReviewPosterDeps {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  logger: Logger;
}

export class ReviewPoster {
  private readonly github: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly prNumber: number;
  private readonly logger: Logger;

  constructor(deps: ReviewPosterDeps) {
    this.github = deps.github;
    this.owner = deps.owner;
    this.repo = deps.repo;
    this.prNumber = deps.prNumber;
    this.logger = deps.logger;
  }

  /**
   * Post exactly one COMMENT review for `round` (FR-001–004, FR-010).
   *
   * Deduped via `listReviews` + the round body marker so a mid-review retry or
   * worker restart does not double-post. Best-effort: any failure is logged and
   * swallowed — the review post must never fail the workflow (FR-008).
   */
  async postRound(artifact: FindingsArtifact, round: number): Promise<void> {
    try {
      // FR-010: skip if this round's review body marker already exists.
      const existing = await this.github.listReviews(this.owner, this.repo, this.prNumber);
      if (isRoundAlreadyPosted(existing, round)) {
        this.logger.debug(
          { owner: this.owner, repo: this.repo, prNumber: this.prNumber, round },
          'Review round already posted — skipping (FR-010 dedupe)',
        );
        return;
      }

      // FR-002a: only diffable anchors can be inline; everything else → body.
      const files = await this.github.listPullRequestFiles(this.owner, this.repo, this.prNumber);
      const diffable = computeDiffableLines(files);
      const { inline, body } = partitionFindings(artifact.findings, diffable);

      const input: CreateReviewInput = {
        event: 'COMMENT', // SC-001 — never REQUEST_CHANGES on our own PR.
        body: buildReviewBody(body, round),
        comments: inline.map(buildInlineComment),
      };

      await this.github.createReview(this.owner, this.repo, this.prNumber, input);
      this.logger.info(
        {
          owner: this.owner,
          repo: this.repo,
          prNumber: this.prNumber,
          round,
          inline: inline.length,
          body: body.length,
        },
        'Posted engine review round',
      );
    } catch (error) {
      this.logger.warn(
        { owner: this.owner, repo: this.repo, prNumber: this.prNumber, round, error: String(error) },
        'Failed to post engine review round (non-fatal)',
      );
    }
  }

  /**
   * On re-review (round ≥ 2): resolve threads whose finding is marked resolved,
   * matched by the per-finding marker in `getPRReviewThreads` comment bodies
   * (FR-009). Each resolve is independent + best-effort — one failure warns and
   * does not block the others or the workflow (FR-008 / US4 AC3).
   */
  async resolveResolvedThreads(artifact: FindingsArtifact): Promise<void> {
    const resolvedFindings = artifact.findings.filter((f) => f.resolved === true);
    if (resolvedFindings.length === 0) return;

    let threads;
    try {
      threads = await this.github.getPRReviewThreads(this.owner, this.repo, this.prNumber);
    } catch (error) {
      this.logger.warn(
        { owner: this.owner, repo: this.repo, prNumber: this.prNumber, error: String(error) },
        'Failed to fetch review threads for resolution (non-fatal)',
      );
      return;
    }

    for (const finding of resolvedFindings) {
      const marker = findingMarker(finding.marker);
      const thread = threads.find((t) => t.comments.some((c) => c.body.includes(marker)));
      if (!thread || thread.isResolved) continue;

      try {
        await this.github.resolveReviewThread(thread.id);
        this.logger.info(
          { owner: this.owner, repo: this.repo, prNumber: this.prNumber, marker: finding.marker },
          'Resolved review thread for addressed finding',
        );
      } catch (error) {
        this.logger.warn(
          {
            owner: this.owner,
            repo: this.repo,
            prNumber: this.prNumber,
            marker: finding.marker,
            error: String(error),
          },
          'Failed to resolve review thread (non-fatal)',
        );
      }
    }
  }
}
