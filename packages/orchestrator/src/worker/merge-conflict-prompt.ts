/**
 * #898 T010 — Bounded conflict-resolution prompt builder.
 *
 * Pure function used by `MergeConflictHandler` to render the agent-CLI prompt
 * before the single autonomous attempt (Q4 → D). Handler contracts:
 * `contracts/handler-contract.md` §"Sibling-owned path constraint".
 *
 * Structure of the emitted prompt:
 *   1. Task framing (what we're resolving, on which branch, against which base).
 *   2. Conflicted-path listing.
 *   3. Sibling-owned constraint paragraph (only when siblingOwnedPaths is non-empty)
 *      forbidding `git checkout --theirs` / `--ours` on those paths.
 *   4. Success predicate — the merge must be conflict-free and committed.
 */

export interface MergeConflictPromptInput {
  /** Paths reported by `git diff --name-only --diff-filter=U`. */
  conflictedPaths: string[];
  /**
   * Subset of `conflictedPaths` that also appear in an open PR targeting the
   * same base branch in the same repo (FR-005 / Q3 → A). These paths require
   * a merged resolution — the agent MUST NOT use `git checkout --theirs` or
   * `--ours` on them.
   */
  siblingOwnedPaths: string[];
  /** Base ref being merged (e.g., `origin/main`). */
  baseRef: string;
  /** Feature branch name (e.g., `898-found-during-cockpit-v1`). */
  branch: string;
}

/**
 * Build the structured merge-conflict-resolution prompt. Deterministic and
 * pure — the same input always produces the same string. No git or gh calls.
 */
export function buildMergeConflictPrompt(input: MergeConflictPromptInput): string {
  const { conflictedPaths, siblingOwnedPaths, baseRef, branch } = input;

  const lines: string[] = [];

  lines.push(`# Task: resolve merge conflicts on branch \`${branch}\` (base: \`${baseRef}\`)`);
  lines.push('');
  lines.push(
    'A `git merge ' + baseRef + '` on the feature branch produced conflicts. ' +
      'The merge is in progress (`.git/MERGE_HEAD` is present). Your task is to ' +
      'resolve the conflicts, stage the resolved files, and commit the merge.',
  );
  lines.push('');
  lines.push('## Conflicted paths');
  lines.push('');
  if (conflictedPaths.length === 0) {
    lines.push('(none reported — this should not happen; investigate git state)');
  } else {
    for (const path of conflictedPaths) {
      const sibling = siblingOwnedPaths.includes(path);
      lines.push(`- \`${path}\`${sibling ? ' **[sibling-owned]**' : ''}`);
    }
  }
  lines.push('');

  if (siblingOwnedPaths.length > 0) {
    lines.push('## Sibling-owned paths (FR-005)');
    lines.push('');
    lines.push(
      'The paths tagged `[sibling-owned]` above are ALSO owned by open pull ' +
        'requests targeting the same base branch (`' + baseRef + '`) in this ' +
        'repository. On these paths, you MUST produce a **merged resolution** ' +
        'that preserves both sides\' semantics.',
    );
    lines.push('');
    lines.push('- Do **NOT** run `git checkout --theirs <path>` on a sibling-owned path.');
    lines.push('- Do **NOT** run `git checkout --ours <path>` on a sibling-owned path.');
    lines.push('- Do **NOT** discard either side\'s changes wholesale.');
    lines.push('');
    lines.push(
      'Edit the file by hand, resolve every conflict marker (`<<<<<<<`, ' +
        '`=======`, `>>>>>>>`), and preserve the intent of both branches. The ' +
        'sibling PR will merge separately; your merge must not silently drop ' +
        'its work.',
    );
    lines.push('');
  }

  lines.push('## Success criteria');
  lines.push('');
  lines.push('When you are finished:');
  lines.push('');
  lines.push('1. No conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain in any file.');
  lines.push('2. `git diff --name-only --diff-filter=U` reports no unmerged paths.');
  lines.push('3. `.git/MERGE_HEAD` no longer exists (the merge commit has been created).');
  lines.push('4. `git status` reports a clean working tree on branch `' + branch + '`.');
  lines.push('');
  lines.push(
    'Commit the merge with `git commit` (no `--amend`, no `--no-verify`). Do not ' +
      'push — the caller will push after verifying the merge state.',
  );

  return lines.join('\n');
}
