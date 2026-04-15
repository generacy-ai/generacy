import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkspaceConfigSchema, type WorkspaceConfig } from './workspace-schema.js';
import { OrchestratorSettingsSchema, TemplateConfigSchema, type OrchestratorSettings } from './template-schema.js';
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
 * Attempt to load and validate orchestrator settings from a YAML file.
 * Returns `null` if the file does not exist or has no `orchestrator` key.
 * Throws if the `orchestrator` key exists but contains invalid config.
 */
export function tryLoadOrchestratorSettings(configPath: string): OrchestratorSettings | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed: unknown = parseYaml(raw);

  if (parsed == null || typeof parsed !== 'object') {
    return null;
  }

  const doc = parsed as Record<string, unknown>;

  if (!('orchestrator' in doc) || doc['orchestrator'] == null) {
    return null;
  }

  return OrchestratorSettingsSchema.parse(doc['orchestrator']);
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
/**
 * Attempt to load `defaults.role` from a `.generacy/config.yaml` file.
 * Returns `null` if the file does not exist, has no `defaults` key, or
 * `defaults.role` is not a string.
 */
export function tryLoadDefaultsRole(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (parsed == null || typeof parsed !== 'object') return null;
    const doc = parsed as Record<string, unknown>;
    const defaults = doc['defaults'];
    if (defaults == null || typeof defaults !== 'object') return null;
    const role = (defaults as Record<string, unknown>)['role'];
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

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
