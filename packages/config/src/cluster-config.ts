import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ClusterLocalYamlSchema,
  ClusterYamlSchema,
  type ClusterLocalYamlData,
  type ClusterYamlData,
} from './cluster-config-schema.js';

export interface MergedClusterConfig {
  /** Shallow per-top-level-key merge: cluster.local.yaml wins per key. */
  merged: ClusterYamlData;
  /** Raw parsed `cluster.yaml`, or `{}` if missing. */
  canonical: ClusterYamlData;
  /** Raw parsed `cluster.local.yaml`, or `{}` if missing. */
  local: ClusterLocalYamlData;
}

async function readAndParse<T>(
  filePath: string,
  schema: { parse(input: unknown): T },
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML at ${filePath}: ${message}`);
  }

  if (parsed == null) {
    return schema.parse({});
  }

  if (typeof parsed !== 'object') {
    throw new Error(`Expected YAML object at ${filePath}, got ${typeof parsed}`);
  }

  return schema.parse(parsed);
}

/**
 * Read .generacy/cluster.yaml and .generacy/cluster.local.yaml, returning the
 * shallow-merged view (local wins per top-level key) plus each raw form.
 *
 * - ENOENT on either file → empty object.
 * - Malformed YAML on either file → throw (fail loud).
 * - Both files missing → all three returned fields are {}.
 */
export async function readMergedClusterConfig(
  generacyDir: string,
): Promise<MergedClusterConfig> {
  const canonicalPath = join(generacyDir, 'cluster.yaml');
  const localPath = join(generacyDir, 'cluster.local.yaml');

  const [canonicalParsed, localParsed] = await Promise.all([
    readAndParse(canonicalPath, ClusterYamlSchema),
    readAndParse(localPath, ClusterLocalYamlSchema),
  ]);

  const canonical: ClusterYamlData = canonicalParsed ?? {};
  const local: ClusterLocalYamlData = localParsed ?? {};

  const merged: ClusterYamlData = { ...canonical, ...local };

  return { merged, canonical, local };
}
