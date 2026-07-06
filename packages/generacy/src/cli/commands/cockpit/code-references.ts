/**
 * `gatherCodeReferences` — collects `{ touchedFiles, prUrl, prDiffSummary }`
 * for the in-flight branch.
 *
 *  - `prUrl`           — open PR for `repo:branch`, or `null`
 *  - `touchedFiles`    — `gh pr diff --name-only` when PR exists, else
 *                        `git diff --name-only <base>...<head>` against the
 *                        configured `baseBranch`. Empty array (never null) when
 *                        no diffs.
 *  - `prDiffSummary`   — first 4 KiB of `gh pr diff --patch` plus optional
 *                        `…[truncated]` suffix. `null` when no PR.
 *
 * Returns `null` when not on a feature branch (i.e. branch matches the base).
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';

export interface CodeReferences {
  touchedFiles: string[];
  prUrl: string | null;
  prDiffSummary: string | null;
}

export interface GatherCodeReferencesInput {
  repo: string;
  branch: string;
  baseBranch: string;
}

const TRUNCATE_SUFFIX = '…[truncated]';
const TRUNCATE_AT = 4096;

export async function gatherCodeReferences(
  input: GatherCodeReferencesInput,
  gh: GhWrapper,
  runner: CommandRunner,
): Promise<CodeReferences | null> {
  if (input.branch === '' || input.branch === input.baseBranch) {
    return null;
  }

  const pr = await gh.findOpenPrForBranch(input.repo, input.branch);

  let touchedFiles: string[] = [];
  let prDiffSummary: string | null = null;

  if (pr) {
    try {
      touchedFiles = await gh.prDiffNames(input.repo, pr.number);
    } catch {
      touchedFiles = [];
    }
    try {
      const patch = await gh.prDiffPatch(input.repo, pr.number);
      prDiffSummary = truncate(patch);
    } catch {
      prDiffSummary = null;
    }
  } else {
    touchedFiles = await gitDiffNames(runner, input.baseBranch, input.branch);
  }

  return {
    touchedFiles,
    prUrl: pr?.url ?? null,
    prDiffSummary,
  };
}

function truncate(patch: string): string {
  if (patch.length <= TRUNCATE_AT) return patch;
  return patch.slice(0, TRUNCATE_AT) + TRUNCATE_SUFFIX;
}

async function gitDiffNames(
  runner: CommandRunner,
  base: string,
  head: string,
): Promise<string[]> {
  const res = await runner('git', ['diff', '--name-only', `${base}...${head}`]);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
