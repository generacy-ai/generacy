import { createHash } from 'node:crypto';
import { LoudResolverError } from './errors.js';
import { parseEpicBody } from './parse-epic-body.js';
import type {
  IssueRef,
  ResolveEpicOptions,
  ResolvedEpic,
} from './types.js';

const EPIC_REGEX = /^([^/]+)\/([^/]+)#(\d+)$/;

function parseEpicRef(epicRef: string): IssueRef {
  const m = EPIC_REGEX.exec(epicRef);
  if (m == null) throw new LoudResolverError('INVALID_EPIC_REF');
  const number = Number.parseInt(m[3]!, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new LoudResolverError('INVALID_EPIC_REF');
  }
  return { repo: `${m[1]!}/${m[2]!}`, number };
}

function uniqSortedRepos(refs: IssueRef[]): string[] {
  const seen = new Set<string>();
  for (const ref of refs) seen.add(ref.repo);
  return [...seen].sort();
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Top-level resolver: fetches the epic body via the injected `GhWrapper`,
 * parses it, forwards parser warnings, and enforces the fail-loud contract
 * (FR-006 / SC-003).
 */
export async function resolveEpic(
  options: ResolveEpicOptions,
): Promise<ResolvedEpic> {
  const epic = parseEpicRef(options.epicRef);

  let body: string;
  try {
    const issue = await options.gh.getIssue(epic.repo, epic.number);
    body = issue.body ?? '';
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new LoudResolverError('GH_FETCH_FAILED', { cause });
  }

  // #1014 (FR-006): pass the epic's own repo as defaultRepo so bare `#N` refs
  // in checkbox task-list items resolve to the scope repo automatically.
  const parsed = parseEpicBody(body, { defaultRepo: epic.repo });

  if (options.logger?.warn != null) {
    for (const w of parsed.warnings) options.logger.warn(w);
  }

  // Flat-list mode: bodies with task-list refs but no `### Phase` headings are
  // valid — the monitored set is exactly `parsed.allRefs`. `NO_REFS` still
  // fires when there are no refs at all.
  if (parsed.allRefs.length === 0) {
    throw new LoudResolverError('NO_REFS');
  }

  const repos = uniqSortedRepos(parsed.allRefs);
  const bodyHash = sha256(body);

  return { epic, parsed, repos, bodyHash };
}
