/**
 * Path resolution library for speckit operations.
 * Ported from speckit MCP server for direct library access.
 */
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  exists,
  readDir,
  findRepoRoot,
  resolveSpecsPath,
  getFilesConfig,
  type FilesConfig,
} from './fs.js';
import { FEATURE_NAME_PATTERN } from './feature.js';
import type { GetPathsInput, GetPathsOutput, FeaturePaths } from '../types.js';

/**
 * Check if git repository exists
 */
async function isGitRepo(path: string): Promise<boolean> {
  return exists(join(path, '.git'));
}

/**
 * Get current git branch name
 */
async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const git = simpleGit(repoRoot);
    const status = await git.status();
    return status.current;
  } catch {
    return null;
  }
}

/**
 * Find feature name from current branch or environment
 */
async function getFeatureName(repoRoot: string, workDir: string): Promise<string | null> {
  // Check environment variable first
  const envFeature = process.env.SPECIFY_FEATURE;
  if (envFeature && FEATURE_NAME_PATTERN.test(envFeature)) {
    return envFeature;
  }

  // Try to get from git branch
  if (await isGitRepo(repoRoot)) {
    const branch = await getCurrentBranch(repoRoot);
    if (branch && FEATURE_NAME_PATTERN.test(branch)) {
      return branch;
    }
  }

  // Try to find the most recent feature directory
  const specsDir = await resolveSpecsPath(workDir);
  if (specsDir && (await exists(specsDir))) {
    const entries = await readDir(specsDir);
    const features = entries
      .filter((e) => FEATURE_NAME_PATTERN.test(e))
      .sort()
      .reverse();
    if (features.length > 0 && features[0]) {
      return features[0];
    }
  }

  return null;
}

/**
 * Build FeaturePaths object from feature name
 */
async function buildFeaturePaths(
  repoRoot: string,
  featureName: string,
  hasGit: boolean,
  filesConfig: FilesConfig,
  workDir: string
): Promise<FeaturePaths> {
  const specsDir = await resolveSpecsPath(workDir) || join(repoRoot, 'specs');
  const featureDir = join(specsDir, featureName);

  return {
    repoRoot,
    branch: featureName,
    hasGit,
    featureDir,
    specFile: join(featureDir, filesConfig.spec),
    planFile: join(featureDir, filesConfig.plan),
    tasksFile: join(featureDir, filesConfig.tasks),
    researchFile: join(featureDir, filesConfig.research),
    dataModelFile: join(featureDir, filesConfig.dataModel),
    quickstartFile: join(featureDir, 'quickstart.md'),
    contractsDir: join(featureDir, 'contracts'),
    checklistsDir: join(featureDir, 'checklists'),
    clarificationsFile: join(featureDir, filesConfig.clarifications),
  };
}

/**
 * Get all feature paths for the current or specified branch.
 * Ported from speckit MCP get_paths tool.
 */
export async function getPaths(input: GetPathsInput): Promise<GetPathsOutput> {
  const workDir = input.cwd || process.cwd();

  // Find repo root
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) {
    return {
      success: false,
      exists: false,
      repoRoot: '',
      branch: '',
      hasGit: false,
      featureDir: '',
      specFile: '',
      planFile: '',
      tasksFile: '',
      researchFile: '',
      dataModelFile: '',
      quickstartFile: '',
      contractsDir: '',
      checklistsDir: '',
      clarificationsFile: '',
    };
  }

  // Determine feature name
  let featureName: string | undefined = input.branch;
  if (!featureName) {
    featureName = (await getFeatureName(repoRoot, workDir)) ?? undefined;
  }

  if (!featureName) {
    return {
      success: false,
      exists: false,
      repoRoot,
      branch: '',
      hasGit: await isGitRepo(repoRoot),
      featureDir: '',
      specFile: '',
      planFile: '',
      tasksFile: '',
      researchFile: '',
      dataModelFile: '',
      quickstartFile: '',
      contractsDir: '',
      checklistsDir: '',
      clarificationsFile: '',
    };
  }

  // Validate feature name pattern
  if (!FEATURE_NAME_PATTERN.test(featureName)) {
    return {
      success: false,
      exists: false,
      repoRoot,
      branch: featureName,
      hasGit: await isGitRepo(repoRoot),
      featureDir: '',
      specFile: '',
      planFile: '',
      tasksFile: '',
      researchFile: '',
      dataModelFile: '',
      quickstartFile: '',
      contractsDir: '',
      checklistsDir: '',
      clarificationsFile: '',
    };
  }

  const hasGit = await isGitRepo(repoRoot);
  const filesConfig = await getFilesConfig(repoRoot);
  const paths = await buildFeaturePaths(repoRoot, featureName, hasGit, filesConfig, workDir);
  const featureDirExists = await exists(paths.featureDir);

  return {
    success: true,
    exists: featureDirExists,
    ...paths,
  };
}
