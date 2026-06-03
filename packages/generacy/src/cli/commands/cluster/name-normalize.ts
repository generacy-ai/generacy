/**
 * Cluster-name normalization helpers shared by `launch` and `deploy`.
 *
 * Algorithm matches research.md §4: lowercase → collapse non-`[a-z0-9-]` runs
 * to `-` → trim → truncate → prepend `c-` if not letter-initial → re-truncate.
 */

const CLUSTER_NAME_MAX_LEN = 63;
const PROJECT_COMPONENT_MAX_LEN = 40;

function normalize(input: string, maxLen: number): string | null {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.slice(0, maxLen);
  s = s.replace(/-+$/g, '');
  if (s === '') return null;
  if (!/^[a-z]/.test(s)) {
    s = `c-${s}`.slice(0, maxLen);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

export function normalizeClusterName(
  input: string,
  maxLen: number = CLUSTER_NAME_MAX_LEN,
): string | null {
  return normalize(input, maxLen);
}

export function sanitizeProjectComponent(
  input: string,
  maxLen: number = PROJECT_COMPONENT_MAX_LEN,
): string {
  return normalize(input, maxLen) ?? 'cluster';
}
