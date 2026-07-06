import type { GhWrapper } from '../gh/wrapper.js';

/**
 * Repo-qualified reference to a GitHub issue or PR.
 */
export interface IssueRef {
  repo: string;
  number: number;
}

export interface ParsedPhase {
  /** Full trimmed heading text after `### `. */
  heading: string;
  /** FR-005 first-token key, lower-cased (e.g. `'s2'`). */
  token: string;
  /** In first-appearance order; deduped within the phase. */
  refs: IssueRef[];
}

export interface ParsedEpicBody {
  /** In body order. */
  phases: ParsedPhase[];
  /** Deduped union across phases, sorted by `(repo, number)`. */
  allRefs: IssueRef[];
  /** Ref-shaped lines that couldn't be resolved (FR-003 warnings). */
  warnings: string[];
}

export interface ResolvedEpic {
  /** The epic itself, parsed from the CLI `--epic owner/repo#N` argument. */
  epic: IssueRef;
  parsed: ParsedEpicBody;
  /** Unique repo set from `parsed.allRefs`, sorted. */
  repos: string[];
  /** sha256 of the raw body — nice-to-have for change detection. */
  bodyHash: string;
}

export interface ResolveEpicOptions {
  epicRef: string;
  gh: GhWrapper;
  logger?: { warn: (m: string) => void };
  now?: () => Date;
}
