/**
 * Feature creation library.
 * Ported from speckit MCP server for direct library access.
 */
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  exists,
  mkdir,
  writeFile,
  readFile,
  readDir,
  findRepoRoot,
  resolveSpecsPath,
} from './fs.js';
import type { CreateFeatureInput, CreateFeatureOutput } from '../types.js';

/** Pattern for valid feature names: \d+-short-name (flexible number padding) */
export const FEATURE_NAME_PATTERN = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Maximum branch name length (GitHub limit) */
export const MAX_BRANCH_LENGTH = 244;

/** Default branch configuration */
const DEFAULT_BRANCH_CONFIG = {
  pattern: '{paddedNumber}-{slug}',
  numberPadding: 3,
  slugOptions: {
    maxLength: 30,
    separator: '-',
    removeStopWords: true,
    maxWords: 4,
  },
};

/** Stop words to remove from slugs */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by',
  'with', 'and', 'or', 'as', 'is', 'it', 'be', 'are', 'was',
  'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'this', 'that', 'these', 'those', 'i', 'we', 'you',
]);

interface BranchConfig {
  pattern: string;
  numberPadding: number;
  slugOptions: {
    maxLength: number;
    separator: string;
    removeStopWords: boolean;
    maxWords: number;
  };
}

/**
 * Load branch configuration from autodev.json
 */
async function loadBranchConfig(repoRoot: string): Promise<BranchConfig> {
  const configPath = join(repoRoot, '.claude', 'autodev.json');

  if (!(await exists(configPath))) {
    return DEFAULT_BRANCH_CONFIG;
  }

  try {
    const content = await readFile(configPath);
    const config = JSON.parse(content);

    if (!config.branches) {
      return DEFAULT_BRANCH_CONFIG;
    }

    return {
      pattern: config.branches.pattern ?? DEFAULT_BRANCH_CONFIG.pattern,
      numberPadding: config.branches.numberPadding ?? DEFAULT_BRANCH_CONFIG.numberPadding,
      slugOptions: {
        ...DEFAULT_BRANCH_CONFIG.slugOptions,
        ...config.branches.slugOptions,
      },
    };
  } catch {
    return DEFAULT_BRANCH_CONFIG;
  }
}

/**
 * Generate a configurable slug from a description
 */
function generateConfigurableSlug(description: string, options: BranchConfig['slugOptions']): string {
  // Normalize: lowercase and replace non-alphanumeric with spaces
  let normalized = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  // Split into words
  let words = normalized.split(/\s+/).filter((word) => word.length > 0);

  // Remove stop words if configured
  if (options.removeStopWords) {
    words = words.filter((word) => !STOP_WORDS.has(word));
  }

  // Limit to maxWords
  if (options.maxWords > 0 && words.length > options.maxWords) {
    words = words.slice(0, options.maxWords);
  }

  // Join with separator
  let slug = words.join(options.separator);

  // Handle empty result
  if (!slug || slug.length < 2) {
    return 'feature';
  }

  // Truncate to maxLength
  if (slug.length > options.maxLength) {
    const truncated = slug.substring(0, options.maxLength);
    const lastSeparatorIndex = truncated.lastIndexOf(options.separator);
    if (lastSeparatorIndex > 0) {
      slug = truncated.substring(0, lastSeparatorIndex);
    } else {
      slug = truncated;
    }
  }

  // Remove trailing separator
  if (slug.endsWith(options.separator)) {
    slug = slug.slice(0, -options.separator.length);
  }

  return slug;
}

/**
 * Build branch name from pattern and context
 */
function buildBranchNameFromPattern(
  config: BranchConfig,
  issueNumber: number,
  description: string
): string {
  const { pattern, numberPadding, slugOptions } = config;

  const paddedNumber = numberPadding > 0
    ? String(issueNumber).padStart(numberPadding, '0')
    : String(issueNumber);

  const slug = generateConfigurableSlug(description, slugOptions);

  let branchName = pattern;
  branchName = branchName.replace('{number}', String(issueNumber));
  branchName = branchName.replace('{paddedNumber}', paddedNumber);
  branchName = branchName.replace('{slug}', slug);

  return branchName;
}

/**
 * Find the next available feature number
 */
async function getNextFeatureNumber(specsDir: string): Promise<string> {
  if (!(await exists(specsDir))) {
    return '001';
  }

  const entries = await readDir(specsDir);
  let maxNumber = 0;

  for (const entry of entries) {
    const match = entry.match(/^(\d+)-/);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) {
        maxNumber = num;
      }
    }
  }

  const nextNum = maxNumber + 1;
  return nextNum.toString().padStart(3, '0');
}

/**
 * Create initial spec content from description
 */
function createInitialSpecContent(
  description: string,
  featureName: string
): string {
  const titlePart = description.split(/[.!?]/)[0] || description;
  const title = titlePart
    .trim()
    .replace(/^(add|create|implement|build)\s+/i, '')
    .replace(/^\w/, (c: string) => c.toUpperCase());

  return `# Feature Specification: ${title}

**Branch**: \`${featureName}\` | **Date**: ${new Date().toISOString().split('T')[0]} | **Status**: Draft

## Summary

${description}

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
`;
}

/**
 * Check if git repository exists
 */
async function isGitRepo(path: string): Promise<boolean> {
  return exists(join(path, '.git'));
}

/**
 * Resolve the default branch name from the remote's HEAD reference.
 * Falls back to 'develop' if the symbolic-ref cannot be read (e.g. shallow clone, detached HEAD).
 */
export async function getDefaultBranch(git: SimpleGit): Promise<string> {
  try {
    const result = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const branch = result.trim().replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // Fallback — symbolic-ref not available
  }
  return 'develop';
}

/**
 * Create a new feature branch and initialize the spec directory with template files.
 * Ported from speckit MCP create_feature tool.
 */
export async function createFeature(input: CreateFeatureInput): Promise<CreateFeatureOutput> {
  const workDir = input.cwd || process.cwd();

  // Find repo root
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) {
    return {
      success: false,
      branch_name: '',
      feature_num: '',
      spec_file: '',
      feature_dir: '',
      git_branch_created: false,
    };
  }

  // Load branch configuration
  const branchConfig = await loadBranchConfig(repoRoot);
  const specsDir = await resolveSpecsPath(workDir) || join(repoRoot, 'specs');

  // Determine feature number
  const featureNumInt = input.number ?? parseInt(await getNextFeatureNumber(specsDir), 10);
  const featureNum = branchConfig.numberPadding > 0
    ? String(featureNumInt).padStart(branchConfig.numberPadding, '0')
    : String(featureNumInt);

  // Validate number range
  if (featureNumInt > 999) {
    return {
      success: false,
      branch_name: '',
      feature_num: '',
      spec_file: '',
      feature_dir: '',
      git_branch_created: false,
    };
  }

  // Create branch name using configured pattern
  const branchName = input.short_name
    ? `${featureNum}-${input.short_name}`
    : buildBranchNameFromPattern(branchConfig, featureNumInt, input.description);

  // Validate branch name
  if (!FEATURE_NAME_PATTERN.test(branchName)) {
    return {
      success: false,
      branch_name: branchName,
      feature_num: featureNum,
      spec_file: '',
      feature_dir: '',
      git_branch_created: false,
    };
  }

  // Create feature directory (idempotent — succeed if it already exists for resume)
  const featureDir = join(specsDir, branchName);
  if (await exists(featureDir)) {
    // Feature dir already exists — this is a resume/requeue.
    // Ensure we're on the right branch and pull latest from remote.
    let gitBranchCreated = false;
    if (await isGitRepo(repoRoot)) {
      const git = simpleGit(repoRoot);
      try {
        await git.fetch(['--all', '--prune']);
      } catch (err) {
        console.warn(`[createFeature] git fetch failed, continuing with possibly stale refs: ${err}`);
      }
      const branches = await git.branchLocal();
      if (branches.all.includes(branchName)) {
        await git.checkout(branchName);
        try {
          await git.pull('origin', branchName);
        } catch {
          // Continue even if pull fails
        }
      } else {
        // Local branch missing but dir exists — check out from remote
        const allBranches = await git.branch(['-a']);
        const remoteBranchExists = allBranches.all.some(
          (b: string) =>
            b === `remotes/origin/${branchName}` ||
            b === `origin/${branchName}`
        );
        if (remoteBranchExists) {
          await git.checkout(['-b', branchName, `origin/${branchName}`]);
        } else {
          // Branch doesn't exist anywhere — create it from default branch HEAD
          const defaultBranch = await getDefaultBranch(git);
          await git.checkout(defaultBranch);
          await git.reset(['--hard', `origin/${defaultBranch}`]);
          await git.checkoutLocalBranch(branchName);
          gitBranchCreated = true;
        }
      }

      // Verify we're actually on the expected branch
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== branchName) {
        return {
          success: false,
          branch_name: branchName,
          feature_num: featureNum,
          spec_file: '',
          feature_dir: featureDir,
          git_branch_created: false,
          error: `Branch checkout failed: expected "${branchName}" but on "${currentBranch}"`,
        };
      }
    }
    const specFile = join(featureDir, 'spec.md');
    return {
      success: true,
      branch_name: branchName,
      feature_num: featureNum,
      spec_file: (await exists(specFile)) ? specFile : '',
      feature_dir: featureDir,
      git_branch_created: gitBranchCreated,
    };
  }

  await mkdir(featureDir);
  await mkdir(join(featureDir, 'checklists'));
  await mkdir(join(featureDir, 'contracts'));

  // Create git branch if in a git repo
  let gitBranchCreated = false;
  let branchedFromEpic = false;
  let baseCommit: string | undefined;

  if (await isGitRepo(repoRoot)) {
    const git = simpleGit(repoRoot);
    const branches = await git.branchLocal();

    if (!branches.all.includes(branchName)) {
      // Fetch remote refs so we can detect existing remote branches
      try {
        await git.fetch(['--all', '--prune']);
      } catch (err) {
        console.warn(`[createFeature] git fetch failed, continuing with possibly stale refs: ${err}`);
      }

      // Check if the branch already exists on remote (resume in fresh workspace)
      const allBranches = await git.branch(['-a']);
      const remoteBranchExists = allBranches.all.some(
        (b: string) =>
          b === `remotes/origin/${branchName}` ||
          b === `origin/${branchName}`
      );

      if (remoteBranchExists) {
        // Track the existing remote branch to pick up previous commits
        await git.checkout(['-b', branchName, `origin/${branchName}`]);
      } else if (input.parent_epic_branch) {
        // Check if the epic branch exists
        const epicBranchExists = allBranches.all.some(
          (b: string) =>
            b === input.parent_epic_branch ||
            b === `remotes/origin/${input.parent_epic_branch}` ||
            b === `origin/${input.parent_epic_branch}`
        );

        if (epicBranchExists) {
          const localBranches = await git.branchLocal();
          if (!localBranches.all.includes(input.parent_epic_branch)) {
            await git.checkout(['-b', input.parent_epic_branch, `origin/${input.parent_epic_branch}`]);
          } else {
            await git.checkout(input.parent_epic_branch);
          }
          await git.reset(['--hard', `origin/${input.parent_epic_branch}`]);
          baseCommit = (await git.revparse(['HEAD'])).trim();
          await git.checkoutLocalBranch(branchName);
          branchedFromEpic = true;
        } else {
          // Epic branch not found — create from current HEAD
          baseCommit = (await git.revparse(['HEAD'])).trim();
          await git.checkoutLocalBranch(branchName);
        }
      } else {
        // Sync to latest default branch before creating feature branch
        // so the new branch forks from the tip of origin/<default>
        const defaultBranch = await getDefaultBranch(git);
        await git.checkout(defaultBranch);
        await git.reset(['--hard', `origin/${defaultBranch}`]);
        baseCommit = (await git.revparse(['HEAD'])).trim();
        await git.checkoutLocalBranch(branchName);
      }
      gitBranchCreated = true;
    } else {
      await git.checkout(branchName);
      // Pull latest from remote in case local is behind (resume scenario)
      try {
        await git.pull('origin', branchName);
      } catch {
        // Continue even if pull fails (e.g., no upstream set)
      }
    }

    // Verify we're actually on the expected branch
    const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== branchName) {
      return {
        success: false,
        branch_name: branchName,
        feature_num: featureNum,
        spec_file: '',
        feature_dir: featureDir,
        git_branch_created: false,
        error: `Branch checkout failed: expected "${branchName}" but on "${currentBranch}"`,
      };
    }
  }

  // Create initial spec.md
  const specFile = join(featureDir, 'spec.md');
  const specContent = createInitialSpecContent(input.description, branchName);
  await writeFile(specFile, specContent);

  return {
    success: true,
    branch_name: branchName,
    feature_num: featureNum,
    spec_file: specFile,
    feature_dir: featureDir,
    git_branch_created: gitBranchCreated,
    branched_from_epic: branchedFromEpic,
    ...(branchedFromEpic && { parent_epic_branch: input.parent_epic_branch }),
    ...(baseCommit && { base_commit: baseCommit }),
  };
}
