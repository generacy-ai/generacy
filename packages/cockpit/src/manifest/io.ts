import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EpicManifestSchema, type EpicManifest } from './schema.js';

/**
 * Read and validate an epic manifest YAML file.
 * Returns null on ENOENT; throws on YAML parse error or schema violation.
 */
export async function readManifest(path: string): Promise<EpicManifest | null> {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML at ${path}: ${msg}`);
  }
  return EpicManifestSchema.parse(parsed);
}

/**
 * Validate and atomically write an epic manifest.
 * Creates parent directories if missing. Writes via temp file + rename.
 */
export async function writeManifest(path: string, manifest: EpicManifest): Promise<void> {
  const validated = EpicManifestSchema.parse(manifest);
  await mkdir(dirname(path), { recursive: true });
  const yaml = stringifyYaml(validated);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, yaml, 'utf-8');
  await rename(tmp, path);
}
