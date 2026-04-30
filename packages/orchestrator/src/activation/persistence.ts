import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ClusterJsonSchema, type ClusterJson } from './types.js';

/**
 * Read the API key from the key file. Returns null if missing or corrupt.
 */
export async function readKeyFile(keyFilePath: string): Promise<string | null> {
  try {
    const content = await readFile(keyFilePath, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Treat any other read error (permission, etc.) as absent
    return null;
  }
}

/**
 * Atomically write the API key to the key file (mode 0600).
 */
export async function writeKeyFile(keyFilePath: string, apiKey: string): Promise<void> {
  const tmpPath = `${keyFilePath}.tmp`;
  try {
    await mkdir(dirname(keyFilePath), { recursive: true });
    await writeFile(tmpPath, apiKey, { mode: 0o600 });
    await rename(tmpPath, keyFilePath);
  } catch (error) {
    throw new Error(
      `Cannot write key file ${keyFilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read and validate cluster.json. Returns null if missing or invalid.
 */
export async function readClusterJson(clusterJsonPath: string): Promise<ClusterJson | null> {
  try {
    const content = await readFile(clusterJsonPath, 'utf-8');
    const json = JSON.parse(content);
    const parsed = ClusterJsonSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write cluster metadata JSON (mode 0644).
 */
export async function writeClusterJson(
  clusterJsonPath: string,
  data: ClusterJson,
): Promise<void> {
  const tmpPath = `${clusterJsonPath}.tmp`;
  try {
    await mkdir(dirname(clusterJsonPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o644 });
    await rename(tmpPath, clusterJsonPath);
  } catch (error) {
    throw new Error(
      `Cannot write cluster.json ${clusterJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
