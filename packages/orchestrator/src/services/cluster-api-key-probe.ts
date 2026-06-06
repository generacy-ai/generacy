import { existsSync } from 'node:fs';

/**
 * Path to the cluster API key file. Must match
 * `packages/control-plane/src/services/cluster-api-key.ts:4` — drift between
 * the two paths reintroduces the gating mismatch.
 */
export const DEFAULT_KEY_PATH = '/var/lib/generacy/cluster-api-key';

/**
 * Returns true iff the cluster API key file exists at the resolved path.
 * Used at orchestrator startup to gate JIT gh provider construction.
 *
 * Resolution order:
 *   1. explicit `keyPath` argument
 *   2. `CLUSTER_API_KEY_PATH` env var (test override)
 *   3. `DEFAULT_KEY_PATH`
 *
 * Pure `existsSync` — does NOT read the file's contents. The control-plane
 * reads contents on every `/git-token` request via its own async
 * `ClusterApiKeyReader`; this helper is intentionally separate so the
 * orchestrator can gate provider construction synchronously at startup
 * without booting the control-plane file reader.
 */
export function clusterApiKeyExists(keyPath?: string): boolean {
  return existsSync(keyPath ?? process.env['CLUSTER_API_KEY_PATH'] ?? DEFAULT_KEY_PATH);
}
