import type { SpawnRecord } from './recording-process-factory.js';

/**
 * Normalizes spawn records for deterministic snapshot output.
 * Sorts env keys alphabetically so snapshot comparisons are stable
 * regardless of object key insertion order.
 */
export function normalizeSpawnRecords(records: SpawnRecord[]): SpawnRecord[] {
  return records.map((record) => ({
    ...record,
    env: Object.fromEntries(
      Object.entries(record.env).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }));
}
