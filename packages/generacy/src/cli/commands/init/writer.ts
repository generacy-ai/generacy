/**
 * File writer for `generacy init`.
 *
 * Writes rendered template files to disk (or previews them in dry-run mode).
 * Also provides a helper to collect existing files that need smart-merge
 * support (e.g. `.vscode/extensions.json`) before template rendering.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogger } from '../../utils/logger.js';
import type { FileAction, FileResult } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files that support smart merge via `renderProject`'s `existingFiles` param. */
const MERGEABLE_FILES = ['.vscode/extensions.json'];

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Write rendered template files to disk, respecting per-file actions and dry-run mode.
 *
 * @param files   - Map of relative path → generated content (from `renderProject`).
 * @param actions - Map of relative path → resolved `FileAction` (from `resolveConflicts`).
 * @param gitRoot - Absolute path to the git repository root.
 * @param dryRun  - When true, record actions without writing to disk.
 * @returns Array of `FileResult` describing what happened to each file.
 */
export async function writeFiles(
  files: Map<string, string>,
  actions: Map<string, FileAction>,
  gitRoot: string,
  dryRun: boolean,
): Promise<FileResult[]> {
  const logger = getLogger();
  const results: FileResult[] = [];

  for (const [relativePath, content] of files) {
    const action = actions.get(relativePath) ?? 'overwrite';
    const fullPath = join(gitRoot, relativePath);
    const size = Buffer.byteLength(content, 'utf-8');

    // Skip
    if (action === 'skip') {
      logger.debug({ path: relativePath }, 'Skipping file');
      results.push({ path: relativePath, action: 'skipped', size: 0 });
      continue;
    }

    // Determine the result action label
    const fileExists = existsSync(fullPath);
    const resultAction: FileResult['action'] =
      action === 'merge' ? 'merged' : fileExists ? 'overwritten' : 'created';

    // Dry-run: record without writing
    if (dryRun) {
      logger.debug({ path: relativePath, size, action: resultAction }, 'Dry-run: would write file');
      results.push({ path: relativePath, action: resultAction, size });
      continue;
    }

    // Create parent directories
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });

    // Write file
    writeFileSync(fullPath, content, 'utf-8');

    // Make shell scripts executable
    if (relativePath.endsWith('.sh')) {
      chmodSync(fullPath, 0o755);
    }

    logger.debug({ path: relativePath, size, action: resultAction }, 'Wrote file');

    results.push({ path: relativePath, action: resultAction, size });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Existing file collector
// ---------------------------------------------------------------------------

/**
 * Collect existing files that support smart merge via `renderProject`.
 *
 * Currently reads `.vscode/extensions.json` if present, so the template engine
 * can merge existing VS Code extension recommendations with generated ones.
 *
 * @param gitRoot - Absolute path to the git repository root.
 * @returns Map of relative path → existing file content.
 */
export function collectExistingFiles(gitRoot: string): Map<string, string> {
  const logger = getLogger();
  const existing = new Map<string, string>();

  for (const relativePath of MERGEABLE_FILES) {
    const fullPath = join(gitRoot, relativePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        existing.set(relativePath, content);
        logger.debug({ path: relativePath }, 'Collected existing file for merge');
      } catch {
        // If we can't read it (permissions, etc.), skip — the template engine
        // will treat it as absent and generate fresh content
        logger.debug({ path: relativePath }, 'Could not read existing file, skipping merge');
      }
    }
  }

  return existing;
}
