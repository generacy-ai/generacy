import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkspaceConfigSchema, type WorkspaceConfig } from './workspace-schema.js';
import { TemplateConfigSchema } from './template-schema.js';
import { convertTemplateConfig } from './convert-template.js';

/**
 * Attempt to load and validate workspace config from a YAML file.
 * Returns `null` if the file does not exist or has no `workspace` key.
 * Throws if the file exists but contains invalid config.
 */
export function tryLoadWorkspaceConfig(configPath: string): WorkspaceConfig | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed: unknown = parseYaml(raw);

  if (parsed == null || typeof parsed !== 'object') {
    return null;
  }

  const doc = parsed as Record<string, unknown>;

  // Existing: try workspace key
  if ('workspace' in doc && doc['workspace'] != null) {
    return WorkspaceConfigSchema.parse(doc['workspace']);
  }

  // Fallback: try template format (repos.primary detection)
  if ('repos' in doc && doc['repos'] != null &&
      typeof doc['repos'] === 'object' && 'primary' in (doc['repos'] as object)) {
    const template = TemplateConfigSchema.parse(doc);
    return convertTemplateConfig(template);
  }

  return null;
}

/**
 * Walk up from `startDir` looking for `{configDirName}/{configFileName}`.
 * Stops at the filesystem root. Returns the full path if found, `null` otherwise.
 */
export function findWorkspaceConfigPath(
  startDir: string,
  configDirName = '.generacy',
  configFileName = 'config.yaml',
): string | null {
  let dir = startDir;

  for (;;) {
    const candidate = join(dir, configDirName, configFileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Scan immediate subdirectories of `parentDir` for a workspace config file.
 * Returns all found config paths (caller decides how to handle multiples).
 */
export function scanForWorkspaceConfig(
  parentDir: string,
  configDirName = '.generacy',
  configFileName = 'config.yaml',
): string[] {
  const entries = readdirSync(parentDir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(parentDir, entry.name, configDirName, configFileName);
    if (existsSync(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}
