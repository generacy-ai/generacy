/**
 * `findClarificationComment` — marker-first / timeline-fallback strategy (#995).
 *
 * Primary path: return the latest-by-`createdAt` non-stage-status comment
 * carrying a `CLARIFICATION_QUESTION_MARKERS` prefix at column 0. This survives
 * `waiting-for:clarification` re-application (requeue / boot-resume / restart)
 * that jumps the label timestamp past every question comment.
 *
 * Fallback path: today's most-recent-`labeled` + at-or-after scan, preserved
 * verbatim for legacy marker-less batches. Emits one `warn` per invocation.
 */
import { matchClarificationQuestionMarker } from '@generacy-ai/orchestrator';
import type { GhWrapper, IssueComment } from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';

const WAITING_CLARIFICATION = 'waiting-for:clarification';

const STAGE_STATUS_REJECT_PREFIXES: readonly string[] = [
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:implementation',
] as const;

const CLARIFICATION_STAGE_OVERRIDE_PREFIXES: readonly string[] = [
  '<!-- generacy-stage:clarification',
  '<!-- generacy-stage:clarification-batch-',
] as const;

function isStageStatusComment(body: string): boolean {
  const lines = body.split('\n');
  for (const line of lines) {
    for (const prefix of CLARIFICATION_STAGE_OVERRIDE_PREFIXES) {
      if (line.startsWith(prefix)) return false;
    }
  }
  for (const line of lines) {
    for (const prefix of STAGE_STATUS_REJECT_PREFIXES) {
      if (line.startsWith(prefix)) return true;
    }
  }
  return false;
}

interface TimelineLabelEvent {
  event?: string;
  created_at?: string;
  label?: { name?: string };
}

export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,
  number: number,
): Promise<IssueComment | null> {
  const comments = await gh.fetchIssueComments(repo, number);

  // Marker-first pass: survives waiting-for:clarification re-application that
  // would otherwise strand the question comment behind the label event.
  const markerHits = comments
    .filter((c) => matchClarificationQuestionMarker(c.body) !== undefined)
    .filter((c) => !isStageStatusComment(c.body))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (markerHits.length > 0) return markerHits[0] ?? null;

  const [owner, repoName] = repo.split('/', 2);
  getLogger().warn(
    { owner, repo: repoName, issue: number },
    `marker-less clarification comment; poster should be updated — issue=${repo}#${number}`,
  );

  const timeline = (await gh.fetchIssueTimeline(repo, number)) as TimelineLabelEvent[];

  let latestLabelTs: string | null = null;
  for (const event of timeline) {
    if (event.event !== 'labeled') continue;
    if (event.label?.name !== WAITING_CLARIFICATION) continue;
    if (event.created_at == null) continue;
    if (latestLabelTs == null || event.created_at > latestLabelTs) {
      latestLabelTs = event.created_at;
    }
  }

  if (latestLabelTs == null) return null;
  const labelTime = Date.parse(latestLabelTs);
  if (Number.isNaN(labelTime)) return null;

  const sorted = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const c of sorted) {
    const ct = Date.parse(c.createdAt);
    if (Number.isNaN(ct) || ct < labelTime) continue;
    if (isStageStatusComment(c.body)) continue;
    return c;
  }
  return null;
}
