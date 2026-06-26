import { join } from 'node:path';

export interface SlugDerivation {
  source: 'flag' | 'derived';
  slug: string;
  path: string;
}

export interface ResolveTargetPathOptions {
  manifestRoot: string;
  slug?: string;
  derivedFromTitle: string;
}

/**
 * Derive a kebab-case slug from an epic title. Falls back to
 * `epic-<number>` when the title is punctuation-only.
 *
 * Algorithm:
 *   1. Strip leading `^(Epic|EPIC):\s*` if present.
 *   2. Lowercase.
 *   3. Replace `[^a-z0-9]+` with `-`.
 *   4. Trim leading/trailing `-`.
 *   5. Collapse repeated `-`.
 *   6. If empty, return `epic-<number>`.
 */
export function deriveSlug(title: string, epicNumber: number): string {
  let s = title.trim();
  s = s.replace(/^(?:Epic|EPIC):\s*/, '');
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.replace(/-+/g, '-');
  if (s.length === 0) return `epic-${epicNumber}`;
  return s;
}

/**
 * Resolve `<manifestRoot>/<slug>.yaml`. If `slug` is provided, source is
 * `'flag'`; otherwise source is `'derived'` and the derived-from-title slug
 * is used. Collision detection is the caller's responsibility.
 */
export function resolveTargetPath(opts: ResolveTargetPathOptions): SlugDerivation {
  const slug = opts.slug ?? opts.derivedFromTitle;
  const source: SlugDerivation['source'] = opts.slug != null ? 'flag' : 'derived';
  return {
    source,
    slug,
    path: join(opts.manifestRoot, `${slug}.yaml`),
  };
}
