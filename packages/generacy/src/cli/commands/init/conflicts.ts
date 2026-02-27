/**
 * File conflict detection and resolution for `generacy init`.
 *
 * When re-running init in a previously initialized repo, this module:
 *   - Detects which rendered files already exist on disk
 *   - Displays unified diffs between existing and generated content
 *   - Prompts the user per-file (overwrite / skip / show diff) unless `--force`
 *   - Auto-merges `.vscode/extensions.json` via the templates `renderProject` merge
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { createTwoFilesPatch } from 'diff';
import type { FileAction, InitOptions } from './types.js';

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Check which rendered files already exist on disk.
 *
 * @param files - Map of relative path → generated content (from `renderProject`).
 * @param gitRoot - Absolute path to the git repository root.
 * @returns Map of conflicting relative paths → existing file content.
 */
export function checkConflicts(
  files: Map<string, string>,
  gitRoot: string,
): Map<string, string> {
  const conflicts = new Map<string, string>();

  for (const relativePath of files.keys()) {
    const fullPath = join(gitRoot, relativePath);
    if (existsSync(fullPath)) {
      try {
        const existing = readFileSync(fullPath, 'utf-8');
        conflicts.set(relativePath, existing);
      } catch {
        // If we can't read it (permissions, etc.), treat as not conflicting
        // so we attempt to overwrite — the writer will surface the real error
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Diff display
// ---------------------------------------------------------------------------

/**
 * Print a unified diff between the existing and generated file content.
 *
 * Uses the `diff` package's `createTwoFilesPatch()` to produce a standard
 * unified diff with `--- existing` / `+++ generated` headers.
 *
 * @param path - Relative file path (used in the diff header).
 * @param existing - Current file content on disk.
 * @param generated - New content that would be written.
 */
export function showDiff(
  path: string,
  existing: string,
  generated: string,
): void {
  const patch = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    existing,
    generated,
    'existing',
    'generated',
    { context: 3 },
  );
  // Use console.log for raw diff output (uncolored, parseable)
  console.log(patch);
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/** Files that receive smart merge instead of overwrite/skip prompting. */
const MERGE_FILES = new Set(['.vscode/extensions.json']);

/**
 * Resolve per-file actions for all rendered files, handling conflicts.
 *
 * - Non-conflicting files → `'overwrite'` (create new).
 * - `--force` flag → all conflicts → `'overwrite'`.
 * - Files in `MERGE_FILES` → `'merge'` (smart merge handled by `renderProject`'s
 *   `existingFiles` parameter upstream).
 * - Otherwise → interactive per-file prompt: Overwrite / Skip / Show diff.
 *
 * @param files - Map of relative path → generated content.
 * @param conflicts - Map of conflicting relative paths → existing content.
 * @param options - Resolved init options (uses `force` and `yes` flags).
 * @returns Map of relative path → resolved `FileAction`.
 */
export async function resolveConflicts(
  files: Map<string, string>,
  conflicts: Map<string, string>,
  options: InitOptions,
): Promise<Map<string, FileAction>> {
  const actions = new Map<string, FileAction>();

  // Non-conflicting files: create (overwrite action for new files)
  for (const relativePath of files.keys()) {
    if (!conflicts.has(relativePath)) {
      actions.set(relativePath, 'overwrite');
    }
  }

  // No conflicts? Done.
  if (conflicts.size === 0) {
    return actions;
  }

  // --force: overwrite everything
  if (options.force) {
    for (const relativePath of conflicts.keys()) {
      actions.set(relativePath, 'overwrite');
    }
    return actions;
  }

  // --yes: accept defaults without prompting (overwrite, but smart-merge where applicable)
  if (options.yes) {
    for (const relativePath of conflicts.keys()) {
      if (MERGE_FILES.has(relativePath)) {
        actions.set(relativePath, 'merge');
      } else {
        actions.set(relativePath, 'overwrite');
      }
    }
    return actions;
  }

  // Resolve each conflict
  for (const [relativePath, existingContent] of conflicts) {
    // Smart merge for known merge-able files
    if (MERGE_FILES.has(relativePath)) {
      actions.set(relativePath, 'merge');
      continue;
    }

    // Interactive prompt per file
    const action = await promptForConflict(
      relativePath,
      existingContent,
      files.get(relativePath)!,
    );
    actions.set(relativePath, action);
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Per-file conflict prompt
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a single conflicting file.
 * Offers: Overwrite, Skip, or Show diff (then re-prompt with Overwrite/Skip).
 */
async function promptForConflict(
  path: string,
  existing: string,
  generated: string,
): Promise<FileAction> {
  const action = await p.select({
    message: `File "${path}" already exists. What would you like to do?`,
    options: [
      { value: 'overwrite', label: 'Overwrite', hint: 'Replace with generated content' },
      { value: 'skip', label: 'Skip', hint: 'Keep existing file' },
      { value: 'diff', label: 'Show diff', hint: 'View changes, then decide' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Operation cancelled.');
    process.exit(130);
  }

  if (action === 'diff') {
    showDiff(path, existing, generated);
    return promptOverwriteOrSkip(path);
  }

  return action as FileAction;
}

/**
 * After showing a diff, prompt with only Overwrite / Skip.
 */
async function promptOverwriteOrSkip(path: string): Promise<FileAction> {
  const action = await p.select({
    message: `"${path}" — overwrite or skip?`,
    options: [
      { value: 'overwrite', label: 'Overwrite', hint: 'Replace with generated content' },
      { value: 'skip', label: 'Skip', hint: 'Keep existing file' },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel('Operation cancelled.');
    process.exit(130);
  }

  return action as FileAction;
}
