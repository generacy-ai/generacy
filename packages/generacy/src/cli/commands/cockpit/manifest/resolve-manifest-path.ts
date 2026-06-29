import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ManifestPathResolution =
  | { kind: 'ok'; path: string }
  | { kind: 'not-found'; root: string }
  | { kind: 'ambiguous'; root: string; matches: string[] };

export interface ResolveManifestPathOptions {
  manifestRoot: string;
  epic?: string;
}

/**
 * Resolve which manifest `sync` should operate on.
 *
 * - With `epic` flag → `<root>/<epic>.yaml` directly (`ok` if exists, else `not-found`).
 * - Without flag → glob `<root>/*.yaml`: exactly one → `ok`; zero → `not-found`;
 *   multiple → `ambiguous` with sorted filenames.
 */
export async function resolveManifestPath(
  opts: ResolveManifestPathOptions,
): Promise<ManifestPathResolution> {
  const { manifestRoot, epic } = opts;
  if (epic != null && epic.length > 0) {
    const path = join(manifestRoot, `${epic}.yaml`);
    if (existsSync(path)) return { kind: 'ok', path };
    return { kind: 'not-found', root: manifestRoot };
  }
  if (!existsSync(manifestRoot)) {
    return { kind: 'not-found', root: manifestRoot };
  }
  const entries = await readdir(manifestRoot);
  const yamlFiles = entries.filter((e) => e.endsWith('.yaml')).sort();
  if (yamlFiles.length === 0) return { kind: 'not-found', root: manifestRoot };
  if (yamlFiles.length === 1) {
    return { kind: 'ok', path: join(manifestRoot, yamlFiles[0]!) };
  }
  return { kind: 'ambiguous', root: manifestRoot, matches: yamlFiles };
}
