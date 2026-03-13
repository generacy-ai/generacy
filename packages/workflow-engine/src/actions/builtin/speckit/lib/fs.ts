/**
 * Shared filesystem utilities for speckit operations.
 * Ported from speckit MCP server for direct library access.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Read file contents as string
 */
export async function readFile(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8');
}

/**
 * Write string content to file, creating parent directories if needed
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path));
  await fs.writeFile(path, content, 'utf-8');
}

/**
 * Check if a file or directory exists
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if path is a directory
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if path is a file
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Create directory and all parent directories if they don't exist
 */
export async function mkdir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/**
 * Copy file from source to destination
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest));
  await fs.copyFile(src, dest);
}

/**
 * List directory contents
 */
export async function readDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/**
 * Find the repository root by looking for .git directory or specs/ folder
 */
export async function findRepoRoot(startPath: string): Promise<string | null> {
  let current = startPath;
  const root = dirname(current);

  while (current !== root) {
    // Check for .git directory
    if (await exists(join(current, '.git'))) {
      return current;
    }
    // Check for specs directory (fallback for non-git repos)
    if (await exists(join(current, 'specs'))) {
      return current;
    }
    current = dirname(current);
  }

  return null;
}

/**
 * Resolve the specs directory path
 * Checks for configured path in .generacy/config.yaml, otherwise defaults to 'specs'
 */
export async function resolveSpecsPath(workDir: string): Promise<string | null> {
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) return null;

  const configPath = join(repoRoot, '.generacy', 'config.yaml');
  if (await exists(configPath)) {
    try {
      const content = await readFile(configPath);
      const config = parseYaml(content);
      if (config?.speckit?.paths?.specs) {
        return join(repoRoot, config.speckit.paths.specs);
      }
    } catch {
      // Ignore parse errors, fall through to default
    }
  }

  return join(repoRoot, 'specs');
}

/**
 * Resolve the templates directory path
 * Checks for configured path in .generacy/config.yaml, otherwise defaults to '.specify/templates'
 */
export async function resolveTemplatesPath(workDir: string): Promise<string | null> {
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) return null;

  const configPath = join(repoRoot, '.generacy', 'config.yaml');
  if (await exists(configPath)) {
    try {
      const content = await readFile(configPath);
      const config = parseYaml(content);
      if (config?.speckit?.paths?.templates) {
        return join(repoRoot, config.speckit.paths.templates);
      }
    } catch {
      // Ignore parse errors, fall through to default
    }
  }

  return join(repoRoot, '.specify', 'templates');
}

/**
 * Default file names configuration
 */
export interface FilesConfig {
  spec: string;
  plan: string;
  tasks: string;
  clarifications: string;
  research: string;
  dataModel: string;
}

/**
 * Get files configuration from .generacy/config.yaml or use defaults
 */
export async function getFilesConfig(repoRoot: string): Promise<FilesConfig> {
  const defaults: FilesConfig = {
    spec: 'spec.md',
    plan: 'plan.md',
    tasks: 'tasks.md',
    clarifications: 'clarifications.md',
    research: 'research.md',
    dataModel: 'data-model.md',
  };

  const configPath = join(repoRoot, '.generacy', 'config.yaml');
  if (await exists(configPath)) {
    try {
      const content = await readFile(configPath);
      const config = parseYaml(content);
      if (config?.speckit?.files) {
        const files = config.speckit.files;
        return {
          spec: files.spec || defaults.spec,
          plan: files.plan || defaults.plan,
          tasks: files.tasks || defaults.tasks,
          clarifications: files.clarifications || defaults.clarifications,
          research: files.research || defaults.research,
          dataModel: files.dataModel || defaults.dataModel,
        };
      }
    } catch {
      // Ignore parse errors, fall through to defaults
    }
  }

  return defaults;
}
