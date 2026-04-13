import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodSchema, ZodError, ZodIssue } from 'zod';
import { RoleConfigSchema, type RoleConfig } from '../schemas/roles.js';
import type { ConfigError } from './types.js';

function mapZodIssue(issue: ZodIssue, file: string, source?: 'committed' | 'overlay'): ConfigError {
  const field = issue.path.length > 0 ? issue.path.join('.') : undefined;
  return { file, field, message: issue.message, source };
}

function mapZodErrors(
  err: ZodError,
  file: string,
  errors: ConfigError[],
  source?: 'committed' | 'overlay',
): void {
  for (const issue of err.issues) {
    errors.push(mapZodIssue(issue, file, source));
  }
}

export function readRequiredYaml<T>(
  filePath: string,
  schema: ZodSchema<T>,
  errors: ConfigError[],
  source?: 'committed' | 'overlay',
): T | null {
  if (!existsSync(filePath)) {
    errors.push({ file: filePath, message: 'Required file not found', source });
    return null;
  }
  try {
    const raw = parseYaml(readFileSync(filePath, 'utf-8'));
    return schema.parse(raw);
  } catch (err) {
    if ((err as { issues?: unknown }).issues) {
      mapZodErrors(err as ZodError, filePath, errors, source);
    } else {
      errors.push({
        file: filePath,
        message: `YAML parse error: ${(err as Error).message}`,
        source,
      });
    }
    return null;
  }
}

export function readOptionalYaml<T>(
  filePath: string,
  schema: ZodSchema<T>,
  errors: ConfigError[],
  source?: 'committed' | 'overlay',
): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = parseYaml(readFileSync(filePath, 'utf-8'));
    return schema.parse(raw);
  } catch (err) {
    if ((err as { issues?: unknown }).issues) {
      mapZodErrors(err as ZodError, filePath, errors, source);
    } else {
      errors.push({
        file: filePath,
        message: `YAML parse error: ${(err as Error).message}`,
        source,
      });
    }
    return null;
  }
}

export function readRoleDirectory(
  rolesDir: string,
  errors: ConfigError[],
): Map<string, RoleConfig> {
  const roles = new Map<string, RoleConfig>();

  if (!existsSync(rolesDir)) {
    return roles;
  }

  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const filePath = join(rolesDir, file);
    const role = readRequiredYaml(filePath, RoleConfigSchema, errors);
    if (role) {
      roles.set(role.id, role);
    }
  }

  return roles;
}
