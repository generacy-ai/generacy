import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ControlPlaneError } from '../errors.js';

export interface SetDefaultRoleOptions {
  role: string;
  agencyDir?: string;
  configPath?: string;
}

export async function setDefaultRole(options: SetDefaultRoleOptions): Promise<void> {
  const agencyDir = options.agencyDir ?? '.agency';
  const configPath = options.configPath ?? '.generacy/config.yaml';

  // Validate role file exists
  const roleFilePath = path.join(agencyDir, 'roles', `${options.role}.yaml`);
  try {
    await fs.access(roleFilePath);
  } catch {
    throw new ControlPlaneError(
      'INVALID_REQUEST',
      `Role '${options.role}' not found: ${roleFilePath} does not exist`,
    );
  }

  // Read existing config or start fresh
  let doc: Record<string, unknown> = {};
  try {
    const existing = await fs.readFile(configPath, 'utf8');
    const parsed = YAML.parse(existing);
    if (parsed && typeof parsed === 'object') {
      doc = parsed as Record<string, unknown>;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // File doesn't exist yet — create it
  }

  // Set defaults.role
  if (!doc.defaults || typeof doc.defaults !== 'object') {
    doc.defaults = {};
  }
  (doc.defaults as Record<string, unknown>).role = options.role;

  // Ensure parent directory exists
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  // Atomic write: temp + rename
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, YAML.stringify(doc), { mode: 0o644 });
  await fs.rename(tmpPath, configPath);
}
