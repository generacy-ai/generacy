import type { SpawnRecord } from './recording-process-factory.js';

/**
 * Environment keys that are explicitly passed by tests/callers.
 * All other env entries (from process.env merged by AgentLauncher) are stripped
 * to keep snapshots stable across environments.
 */
const SNAPSHOT_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_MAX_TURNS',
  'PATH',
]);

/**
 * Normalizes spawn records for deterministic snapshot output.
 * - Strips process.env entries injected by AgentLauncher's 3-layer env merge,
 *   keeping only explicitly-provided caller env keys.
 * - Sorts env keys alphabetically so snapshot comparisons are stable
 *   regardless of object key insertion order.
 */
export function normalizeSpawnRecords(records: SpawnRecord[]): SpawnRecord[] {
  return records.map((record) => ({
    ...record,
    env: Object.fromEntries(
      Object.entries(record.env)
        .filter(([key]) => SNAPSHOT_ENV_ALLOWLIST.has(key))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  }));
}
