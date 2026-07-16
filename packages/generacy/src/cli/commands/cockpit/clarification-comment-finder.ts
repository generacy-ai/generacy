/**
 * `findClarificationComment` — implements AD-3 / D-R1:
 *
 *  1. Walk `gh api repos/{o}/{r}/issues/{n}/timeline` for the most-recent event
 *     `event === 'labeled'` with `label.name === 'waiting-for:clarification'`.
 *  2. Take its `created_at` timestamp.
 *  3. Fetch `gh issue view --json comments` and return the first comment whose
 *     `createdAt >= labelEventTs`.
 *  4. Return `null` if no qualifying comment exists.
 */
import type { GhWrapper, IssueComment } from '@generacy-ai/cockpit';

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

  const comments = await gh.fetchIssueComments(repo, number);
  const sorted = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const c of sorted) {
    const ct = Date.parse(c.createdAt);
    if (Number.isNaN(ct) || ct < labelTime) continue;
    if (isStageStatusComment(c.body)) continue;
    return c;
  }
  return null;
}
