/**
 * Extracts declared cross-issue dependencies from a spec's `plan.md` file.
 *
 * v1 heuristic (contracts/plan-dependency-warning.md §Extractor):
 *   - Trigger verbs: `must be merged`, `must merge first`, `depends on`, `depends-on`,
 *     `requires`, `extends`, `blocked by`, `prerequisite`.
 *   - Extract `#\d+` (bare) → `{ defaultOwner, defaultRepo, N }`
 *   - Extract `[\w-]+/[\w-]+#\d+` → cross-repo
 *   - Search the trigger line PLUS the immediately-following line (wrapping tolerance).
 *   - Skip fenced code blocks (` ``` `) and inline code (backticks).
 *   - De-duplicate by `owner/repo/number`, preserving first-occurrence order.
 *
 * `originatingText` is derived from the trigger line, bounded to 120 chars.
 */

export interface DependencyRef {
  owner: string;
  repo: string;
  number: number;
  /** The originating span from the plan.md line (bounded to 120 chars). */
  originatingText: string;
}

const TRIGGER_VERBS = [
  'must be merged',
  'must merge first',
  'depends on',
  'depends-on',
  'requires',
  'extends',
  'blocked by',
  'prerequisite',
];

const CROSS_REPO_REF = /([A-Za-z0-9][\w-]*)\/([A-Za-z0-9][\w-]*)#(\d+)/g;
const BARE_REF = /#(\d+)/g;

const ORIGINATING_TEXT_MAX = 120;

/**
 * Strip inline code spans (`...`) from a line so bare-ref regex doesn't match inside them.
 *
 * Handles the simple case of paired backticks; unpaired backticks are preserved.
 */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, '');
}

function boundOriginatingText(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= ORIGINATING_TEXT_MAX) return trimmed;
  return trimmed.slice(0, ORIGINATING_TEXT_MAX);
}

function lineHasTrigger(line: string): boolean {
  const lower = line.toLowerCase();
  return TRIGGER_VERBS.some((v) => lower.includes(v));
}

/**
 * Extract dependency refs from `plan.md` markdown.
 *
 * @param planMarkdown Raw markdown body.
 * @param defaultOwner Owner for bare `#N` refs (typically the current issue's owner).
 * @param defaultRepo Repo for bare `#N` refs (typically the current issue's repo).
 */
export function extractPlanDependencies(
  planMarkdown: string,
  defaultOwner: string,
  defaultRepo: string,
): DependencyRef[] {
  const lines = planMarkdown.split('\n');
  const results: DependencyRef[] = [];
  const seen = new Set<string>();

  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // Toggle fenced-code-block state on ``` boundaries.
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!lineHasTrigger(rawLine)) continue;

    // Wrap tolerance: also scan the following non-fence line (if any).
    const triggerLine = stripInlineCode(rawLine);
    let followingLine = '';
    if (i + 1 < lines.length) {
      const nextRaw = lines[i + 1]!;
      // Stop before a fenced-code boundary.
      if (!nextRaw.trim().startsWith('```')) {
        followingLine = stripInlineCode(nextRaw);
      }
    }
    const searchSpan = `${triggerLine}\n${followingLine}`;

    const originatingText = boundOriginatingText(rawLine);

    // Cross-repo mentions first (they consume the trailing `#N`).
    const crossRepoMatches: Array<{ owner: string; repo: string; number: number; matchStart: number; matchEnd: number }> = [];
    CROSS_REPO_REF.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CROSS_REPO_REF.exec(searchSpan)) !== null) {
      const num = Number.parseInt(m[3]!, 10);
      if (Number.isFinite(num) && num > 0) {
        crossRepoMatches.push({
          owner: m[1]!,
          repo: m[2]!,
          number: num,
          matchStart: m.index,
          matchEnd: m.index + m[0].length,
        });
      }
    }
    for (const cr of crossRepoMatches) {
      const key = `${cr.owner}/${cr.repo}#${cr.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          owner: cr.owner,
          repo: cr.repo,
          number: cr.number,
          originatingText,
        });
      }
    }

    // Bare `#N` — must not be part of a cross-repo match already consumed.
    BARE_REF.lastIndex = 0;
    while ((m = BARE_REF.exec(searchSpan)) !== null) {
      const matchStart = m.index;
      const matchEnd = matchStart + m[0].length;
      const insideCrossRepo = crossRepoMatches.some(
        (cr) => matchStart >= cr.matchStart && matchEnd <= cr.matchEnd,
      );
      if (insideCrossRepo) continue;
      const num = Number.parseInt(m[1]!, 10);
      if (!Number.isFinite(num) || num <= 0) continue;
      const key = `${defaultOwner}/${defaultRepo}#${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        owner: defaultOwner,
        repo: defaultRepo,
        number: num,
        originatingText,
      });
    }
  }

  return results;
}
