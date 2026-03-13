/**
 * Template fetcher — downloads cluster base repo files from GitHub as a tarball.
 *
 * Fetches devcontainer files from the per-variant base repos
 * (`generacy-ai/cluster-base` or `generacy-ai/cluster-microservices`),
 * and caches the result locally at `~/.generacy/template-cache/{repo-name}/{ref}/`.
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

/** Maps each cluster variant to its dedicated GitHub repository. */
const VARIANT_REPOS: Record<ClusterVariant, string> = {
  standard: 'generacy-ai/cluster-base',
  microservices: 'generacy-ai/cluster-microservices',
};

/** Default git ref for base repos. */
const DEFAULT_REF = 'main';

const CACHE_BASE = '.generacy/template-cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for fetching cluster templates. */
export interface FetchOptions {
  /** Cluster variant to extract from the tarball. */
  variant: ClusterVariant;
  /** Git ref (branch, tag, or commit SHA) to fetch. Defaults to `'main'`. */
  ref?: string;
  /** GitHub token for authorization. If omitted, requests are unauthenticated. */
  token?: string | null;
  /** When true, bypass the local cache and re-download. */
  refreshCache?: boolean;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Resolve the cache directory for a given repo name and ref. */
function getCacheDir(repoName: string, ref: string): string {
  return join(homedir(), CACHE_BASE, repoName, ref);
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
 * GitHub tarballs nest files under `{owner}-{repo}-{shortsha}/`.
 * We strip that top-level prefix. Base repos have files at root level
 * (e.g. `.devcontainer/Dockerfile`), so no variant prefix to strip.
 *
 * Example: `generacy-ai-cluster-base-abc1234/.devcontainer/Dockerfile`
 *        → `.devcontainer/Dockerfile`
 */
function mapArchivePath(archivePath: string): string | null {
  const firstSlash = archivePath.indexOf('/');
  if (firstSlash === -1) return null;

  const rest = archivePath.slice(firstSlash + 1);
  return rest || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch cluster base repo files from GitHub.
 *
 * Downloads the tarball for the given variant's base repo, extracts all files,
 * and caches them locally. Subsequent calls with the same repo and ref are
 * served from cache unless `refreshCache` is set.
 *
 * @returns Map from target path (e.g. `.devcontainer/Dockerfile`) to file content.
 * @throws {Error} On network failures or HTTP errors.
 */
export async function fetchClusterTemplates(
  options: FetchOptions,
): Promise<Map<string, string>> {
  const logger = getLogger();
  const ref = options.ref ?? DEFAULT_REF;
  const { variant, token, refreshCache } = options;

  const repo = VARIANT_REPOS[variant];
  const repoName = repo.split('/')[1]!;

  // ── Check cache ──────────────────────────────────────────────────────────
  const cacheDir = getCacheDir(repoName, ref);

  if (!refreshCache) {
    const cached = readCache(cacheDir);
    if (cached) {
      logger.debug({ ref, variant, cacheDir }, 'Using cached cluster templates');
      return cached;
    }
  }

  // ── Fetch tarball ────────────────────────────────────────────────────────
  const url = `https://api.github.com/repos/${repo}/tarball/${ref}`;
  logger.debug({ url, variant }, 'Fetching cluster base repo tarball');

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
      `Failed to fetch ${repoName} — check your network connection`,
      { cause: error },
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Template ref '${ref}' not found in ${repo}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Authentication required or rate limited — provide a GitHub token',
      );
    }
    throw new Error(
      `Failed to fetch ${repoName} (HTTP ${response.status})`,
    );
  }

  // ── Extract tarball ──────────────────────────────────────────────────────
  const buffer = Buffer.from(await response.arrayBuffer());

  const rawFiles = await extractTarGz(buffer, () => true);

  // ── Map archive paths → target paths ─────────────────────────────────────
  const files = new Map<string, string>();

  for (const [archivePath, content] of rawFiles) {
    const targetPath = mapArchivePath(archivePath);
    if (targetPath) {
      files.set(targetPath, content);
    }
  }

  logger.debug({ ref, variant, fileCount: files.size }, 'Extracted cluster base repo files');

  // ── Update cache ─────────────────────────────────────────────────────────
  mkdirSync(cacheDir, { recursive: true });
  writeCache(cacheDir, files);
  logger.debug({ cacheDir }, 'Cached cluster templates');

  return files;
}
