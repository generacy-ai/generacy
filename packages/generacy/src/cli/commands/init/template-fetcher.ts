/**
 * Template fetcher — downloads cluster-templates from GitHub as a tarball.
 *
 * Fetches devcontainer files from the `generacy-ai/cluster-templates` repo,
 * extracts the variant-specific directory, and caches the result locally
 * at `~/.generacy/template-cache/{ref}/{variant}/`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../../utils/logger.js';
import { extractTarGz } from './tar-utils.js';
import type { ClusterVariant } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = 'generacy-ai/cluster-templates';
const TARBALL_URL = `https://api.github.com/repos/${REPO}/tarball`;
const CACHE_BASE = '.generacy/template-cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for fetching cluster templates. */
export interface FetchOptions {
  /** Cluster variant to extract from the tarball. */
  variant: ClusterVariant;
  /** Git ref (branch, tag, or commit SHA) to fetch. Defaults to `'develop'`. */
  ref?: string;
  /** GitHub token for authorization. If omitted, requests are unauthenticated. */
  token?: string | null;
  /** When true, bypass the local cache and re-download. */
  refreshCache?: boolean;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Resolve the cache directory for a given ref and variant. */
function getCacheDir(ref: string, variant: ClusterVariant): string {
  return join(homedir(), CACHE_BASE, ref, variant);
}

/**
 * Read cached template files from disk.
 *
 * @returns Map of target paths → file content, or `null` if no cache exists.
 */
function readCache(cacheDir: string): Map<string, string> | null {
  if (!existsSync(cacheDir)) return null;

  const files = new Map<string, string>();

  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.set(rel, readFileSync(full, 'utf-8'));
      }
    }
  }

  walk(cacheDir, '');

  // Empty cache directory counts as no cache
  if (files.size === 0) return null;

  return files;
}

/**
 * Write extracted files to the cache directory.
 */
function writeCache(cacheDir: string, files: Map<string, string>): void {
  for (const [rel, content] of files) {
    const full = join(cacheDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Path mapping
// ---------------------------------------------------------------------------

/**
 * Map an archive path to its target output path.
 *
 * GitHub tarballs nest files under `{owner}-{repo}-{shortsha}/`. Within that,
 * the variant directory (e.g. `standard/`) contains the devcontainer files.
 * We strip the top-level dir and variant prefix, then prepend `.devcontainer/`.
 *
 * Example: `generacy-ai-cluster-templates-abc1234/standard/Dockerfile`
 *        → `.devcontainer/Dockerfile`
 *
 * Files outside the variant directory are included at the repo root level
 * (e.g. `.gitattributes`).
 */
function mapArchivePath(
  archivePath: string,
  variant: ClusterVariant,
): string | null {
  // Split off the top-level directory (GitHub's generated prefix)
  const firstSlash = archivePath.indexOf('/');
  if (firstSlash === -1) return null;

  const rest = archivePath.slice(firstSlash + 1);
  if (!rest) return null;

  // Files under the variant directory → .devcontainer/
  const variantPrefix = `${variant}/`;
  if (rest.startsWith(variantPrefix)) {
    const innerPath = rest.slice(variantPrefix.length);
    return innerPath ? `.devcontainer/${innerPath}` : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch cluster template files from the `cluster-templates` GitHub repo.
 *
 * Downloads the tarball for the given ref, extracts files for the specified
 * variant, and caches them locally. Subsequent calls with the same ref and
 * variant are served from cache unless `refreshCache` is set.
 *
 * @returns Map from target path (e.g. `.devcontainer/Dockerfile`) to file content.
 * @throws {Error} On network failures or HTTP errors.
 */
export async function fetchClusterTemplates(
  options: FetchOptions,
): Promise<Map<string, string>> {
  const logger = getLogger();
  const ref = options.ref ?? 'develop';
  const { variant, token, refreshCache } = options;

  // ── Check cache ──────────────────────────────────────────────────────────
  const cacheDir = getCacheDir(ref, variant);

  if (!refreshCache) {
    const cached = readCache(cacheDir);
    if (cached) {
      logger.debug({ ref, variant, cacheDir }, 'Using cached cluster templates');
      return cached;
    }
  }

  // ── Fetch tarball ────────────────────────────────────────────────────────
  const url = `${TARBALL_URL}/${ref}`;
  logger.debug({ url, variant }, 'Fetching cluster templates tarball');

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'generacy-cli',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw new Error(
      'Failed to fetch cluster templates — check your network connection',
      { cause: error },
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Template ref '${ref}' not found in cluster-templates repository`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Authentication required or rate limited — provide a GitHub token',
      );
    }
    throw new Error(
      `Failed to fetch cluster templates (HTTP ${response.status})`,
    );
  }

  // ── Extract tarball ──────────────────────────────────────────────────────
  const buffer = Buffer.from(await response.arrayBuffer());
  const variantPrefix = `${variant}/`;

  const rawFiles = await extractTarGz(buffer, (path) => {
    // Match files under the variant directory inside the top-level dir
    const firstSlash = path.indexOf('/');
    if (firstSlash === -1) return false;
    const rest = path.slice(firstSlash + 1);
    return rest.startsWith(variantPrefix);
  });

  // ── Map archive paths → target paths ─────────────────────────────────────
  const files = new Map<string, string>();

  for (const [archivePath, content] of rawFiles) {
    const targetPath = mapArchivePath(archivePath, variant);
    if (targetPath) {
      files.set(targetPath, content);
    }
  }

  logger.debug({ ref, variant, fileCount: files.size }, 'Extracted cluster template files');

  // ── Update cache ─────────────────────────────────────────────────────────
  mkdirSync(cacheDir, { recursive: true });
  writeCache(cacheDir, files);
  logger.debug({ cacheDir }, 'Cached cluster templates');

  return files;
}
