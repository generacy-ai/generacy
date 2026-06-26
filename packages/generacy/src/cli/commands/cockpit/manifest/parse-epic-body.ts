import { CockpitExit } from '../exit.js';
import { extractPlan } from './extract-plan.js';

export interface ParsedPhase {
  index: number;
  name: string;
  tier?: string;
  issues: string[];
}

export interface ParsedEpicBody {
  plan: string;
  phases: ParsedPhase[];
}

const HEADING_RE = /^(##|###|####)\s+(.*)$/;
const PHASE_INDEX_RE = /\bP(\d+)\b/i;
const TIER_RE = /(?:→|->)\s*(v\d+)/i;
const ISSUE_REF_RE =
  /^\s*-\s*(?:\[[ xX]\]\s*)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+)(?:\s*[—-]\s*.+)?$/;

function stripTrailingTokens(headingTitle: string): string {
  let title = headingTitle.trim();
  title = title.replace(/(?:→|->)\s*v\d+\s*$/i, '').trim();
  return title;
}

/**
 * Parse an epic issue body into `{ plan, phases }`. Line-oriented walker.
 *
 * Grammar:
 *   - Heading: `^(##|###|####)\s+(.*)$`, containing `P\d+` token anywhere.
 *   - Bullet:  `^\s*-\s*(\[[ xX]\]\s*)?owner/repo#n( — Title)?$`.
 *   - Anything else: silently skipped (prose).
 *
 * Duplicate phase index → keep first, log warn to stderr.
 * Duplicate issue ref within a phase → dedupe, preserve first occurrence.
 * Zero phases → CockpitExit(2).
 */
export function parseEpicBody(body: string): ParsedEpicBody {
  const plan = extractPlan(body);
  const phases: ParsedPhase[] = [];
  const seenIndices = new Set<number>();
  let current: ParsedPhase | null = null;
  let currentSeenRefs = new Set<string>();

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch != null) {
      const title = headingMatch[2]!.trim();
      const indexMatch = title.match(PHASE_INDEX_RE);
      if (indexMatch == null) {
        current = null;
        currentSeenRefs = new Set();
        continue;
      }
      const index = Number.parseInt(indexMatch[1]!, 10);
      if (seenIndices.has(index)) {
        process.stderr.write(
          `Warning: cockpit manifest: duplicate phase index P${index}; keeping first occurrence.\n`,
        );
        current = null;
        currentSeenRefs = new Set();
        continue;
      }
      seenIndices.add(index);
      const tierMatch = title.match(TIER_RE);
      const tier = tierMatch != null ? tierMatch[1]! : undefined;
      const name = stripTrailingTokens(title);
      current = tier != null ? { index, name, tier, issues: [] } : { index, name, issues: [] };
      currentSeenRefs = new Set();
      phases.push(current);
      continue;
    }

    const bulletMatch = line.match(ISSUE_REF_RE);
    if (bulletMatch != null && current != null) {
      const ref = bulletMatch[1]!;
      if (!currentSeenRefs.has(ref)) {
        currentSeenRefs.add(ref);
        current.issues.push(ref);
      }
    }
  }

  if (phases.length === 0) {
    throw new CockpitExit(
      2,
      `Error: cockpit manifest init: epic body has no 'P\\d+' phase headings — body may be malformed.`,
    );
  }

  return { plan, phases };
}
