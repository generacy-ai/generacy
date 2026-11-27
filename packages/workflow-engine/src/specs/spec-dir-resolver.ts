/**
 * Numeric spec-directory resolver (#1241).
 *
 * spec-kit names feature directories with a zero-padded leading number
 * (`specs/006-foo` for issue 6). String-prefix matching `${issueNumber}-`
 * never matches a padded dir for any issue below 100, so every call site that
 * resolved spec dirs by prefix silently failed on low-numbered issues. This
 * module is the single source of truth for that resolution: it compares the
 * *numeric* value of the leading `^(\d+)-` segment against the issue number.
 *
 * Pure — operates on a pre-read directory listing, no I/O — so both sync
 * (`readdirSync`) and async (`readdir`) call sites share it unchanged.
 */

/** Leading decimal segment immediately followed by `-` (spec-kit convention). */
const LEADING_NUMBER = /^(\d+)-/;

/**
 * Result of resolving a spec directory for an issue number.
 *
 * - `match` — exactly one directory resolves (after exact-match precedence).
 * - `none` — no directory resolves.
 * - `ambiguous` — no exact non-padded match and more than one padded directory
 *   resolves to the same issue number.
 */
export type SpecDirMatch =
  | { kind: 'match'; dir: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; dirs: string[] };

/**
 * Resolve the spec directory for `issueNumber` from a directory listing.
 *
 * Algorithm (FR-001/002/002a/002b/003/004):
 *   1. `candidates` = entries where `^(\d+)-` matches and
 *      `Number(digits) === issueNumber`.
 *   2. `exact` = candidates whose digits are the non-padded `String(issueNumber)`.
 *   3. One exact → `match`; multiple exact → `ambiguous(exact)` (defensive).
 *   4. No exact: one candidate → `match`; multiple → `ambiguous(candidates)`;
 *      zero → `none`.
 *
 * The `-` anchor means `006abc-foo` never matches issue 6 and non-numeric
 * entries (`contracts`) are ignored.
 */
export function matchSpecDir(entries: string[], issueNumber: number): SpecDirMatch {
  const candidates: string[] = [];
  const exact: string[] = [];
  const target = String(issueNumber);

  for (const entry of entries) {
    const m = LEADING_NUMBER.exec(entry);
    if (m === null) continue;
    const digits = m[1]!;
    if (Number(digits) !== issueNumber) continue;
    candidates.push(entry);
    if (digits === target) exact.push(entry);
  }

  if (exact.length === 1) return { kind: 'match', dir: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', dirs: exact };

  if (candidates.length === 1) return { kind: 'match', dir: candidates[0]! };
  if (candidates.length > 1) return { kind: 'ambiguous', dirs: candidates };
  return { kind: 'none' };
}

/**
 * Convenience wrapper over {@link matchSpecDir}: the directory name on a unique
 * `match`, `undefined` on `none` or `ambiguous`. Call sites that don't need to
 * distinguish ambiguity (the five `find`-style resolvers) use this.
 */
export function findSpecDirName(entries: string[], issueNumber: number): string | undefined {
  const result = matchSpecDir(entries, issueNumber);
  return result.kind === 'match' ? result.dir : undefined;
}
