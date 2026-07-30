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
  /**
   * Task-list refs collected outside any phase — appearing before the first
   * `### ` heading, under a `## Ad-hoc` L2 section, or after a `####+`
   * terminator. First-appearance order, deduped within adhoc. Empty when
   * no adhoc/preamble refs are present.
   */
  adhocRefs: IssueRef[];
  /** Deduped union across phases + adhoc, sorted by `(repo, number)`. */
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

/**
 * Options for `parseEpicBody`. All fields are optional; passing no options
 * (or an empty object) is equivalent to calling `parseEpicBody(body)`.
 */
export interface ParseEpicBodyOptions {
  /**
   * Canonical `"owner/repo"` string. When set, a bare `#N` ref inside a
   * task-list checkbox item (`- [ ] #N` / `- [x] #N`) is accepted and
   * resolved to `<defaultRepo>#N`. Bare refs outside checkbox items
   * remain unaffected. When absent (or undefined), the parser rejects
   * bare refs with the existing #826 warning.
   *
   * Validation: MUST match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`.
   * Malformed input is treated as if the option were absent, and a
   * warning is emitted (marker substring: `invalid defaultRepo`).
   * Never throws.
   */
  defaultRepo?: string;
}
