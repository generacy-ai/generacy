/**
 * Prerequisites checking library for speckit operations.
 * Ported from speckit MCP server for direct library access.
 */
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  exists,
  isFile,
  isDirectory,
  readDir,
  findRepoRoot,
  resolveSpecsPath,
  getFilesConfig,
  type FilesConfig,
} from './fs.js';
import { FEATURE_NAME_PATTERN } from './feature.js';
import type { CheckPrereqsInput, CheckPrereqsOutput } from '../types.js';

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
 * Get list of available optional documents in feature directory
 */
async function getAvailableDocs(
  featureDir: string,
  filesConfig: FilesConfig
): Promise<string[]> {
  // Build optional docs list from config
  const optionalDocs = [
    filesConfig.research,
    filesConfig.dataModel,
    'quickstart.md',
  ];

  const available: string[] = [];

  // Check for optional markdown files
  for (const doc of optionalDocs) {
    if (await isFile(join(featureDir, doc))) {
      available.push(doc);
    }
  }

  // Check for contracts directory with content
  const contractsDir = join(featureDir, 'contracts');
  if (await isDirectory(contractsDir)) {
    const contracts = await readDir(contractsDir);
    if (contracts.length > 0) {
      available.push('contracts/');
    }
  }

  // Check for checklists directory with content
  const checklistsDir = join(featureDir, 'checklists');
  if (await isDirectory(checklistsDir)) {
    const checklists = await readDir(checklistsDir);
    if (checklists.length > 0) {
      available.push('checklists/');
    }
  }

  return available;
}

/**
 * Check prerequisites for a command.
 * Validates required files exist and returns list of available optional documents.
 * Ported from speckit MCP check_prereqs tool.
 */
export async function checkPrereqs(input: CheckPrereqsInput): Promise<CheckPrereqsOutput> {
  const workDir = input.cwd || process.cwd();
  const requireSpec = input.require_spec ?? true;
  const requirePlan = input.require_plan ?? false;
  const requireTasks = input.require_tasks ?? false;
  const includeTasks = input.include_tasks ?? false;

  // Find repo root
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) {
    return {
      valid: false,
      featureDir: '',
      availableDocs: [],
      error: 'Could not find repository root',
    };
  }

  // Determine feature name
  let featureName: string | undefined = input.branch;
  if (!featureName) {
    featureName = (await getFeatureName(repoRoot, workDir)) ?? undefined;
  }

  if (!featureName) {
    return {
      valid: false,
      featureDir: '',
      availableDocs: [],
      error:
        'Could not determine feature name. Use a feature branch (###-name) or set SPECIFY_FEATURE env var.',
    };
  }

  // Validate feature name pattern
  if (!FEATURE_NAME_PATTERN.test(featureName)) {
    return {
      valid: false,
      featureDir: '',
      availableDocs: [],
      error: `Branch name '${featureName}' does not match required pattern ###-name`,
    };
  }

  const specsDir = await resolveSpecsPath(workDir) || join(repoRoot, 'specs');
  const featureDir = join(specsDir, featureName);

  // Check if feature directory exists
  if (!(await exists(featureDir))) {
    return {
      valid: false,
      featureDir,
      availableDocs: [],
      missingRequired: ['feature directory'],
      error: `Feature directory does not exist: ${featureDir}`,
    };
  }

  // Load files configuration
  const filesConfig = await getFilesConfig(repoRoot);

  // Check required files
  const missingRequired: string[] = [];

  if (requireSpec) {
    const specFile = join(featureDir, filesConfig.spec);
    if (!(await isFile(specFile))) {
      missingRequired.push(filesConfig.spec);
    }
  }

  if (requirePlan) {
    const planFile = join(featureDir, filesConfig.plan);
    if (!(await isFile(planFile))) {
      missingRequired.push(filesConfig.plan);
    }
  }

  if (requireTasks) {
    const tasksFile = join(featureDir, filesConfig.tasks);
    if (!(await isFile(tasksFile))) {
      missingRequired.push(filesConfig.tasks);
    }
  }

  // Get available optional docs
  const availableDocs = await getAvailableDocs(featureDir, filesConfig);

  // Include tasks.md if requested and exists
  if (includeTasks) {
    const tasksFile = join(featureDir, filesConfig.tasks);
    if (await isFile(tasksFile)) {
      availableDocs.push(filesConfig.tasks);
    }
  }

  if (missingRequired.length > 0) {
    return {
      valid: false,
      featureDir,
      availableDocs,
      missingRequired,
      error: `Missing required files: ${missingRequired.join(', ')}`,
    };
  }

  return {
    valid: true,
    featureDir,
    availableDocs,
  };
}
