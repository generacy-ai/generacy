/**
 * Spawn Snapshot Test Harness
 *
 * Usage (Waves 2-3 migration tests):
 *
 * ```ts
 * import { RecordingProcessFactory, normalizeSpawnRecords } from '../test-utils/index.js';
 *
 * const factory = new RecordingProcessFactory();
 * const spawner = new CliSpawner(factory, logger);
 *
 * await spawner.spawnPhase('implement', options, capture);
 *
 * expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
 * ```
 *
 * Snapshot update workflow:
 * 1. Make your migration changes to cli-spawner or spawn composition
 * 2. Run `pnpm --filter orchestrator test` — snapshot tests will fail showing the diff
 * 3. Review the diff to confirm the change is intentional
 * 4. Run `pnpm --filter orchestrator test -- --update` to accept the new snapshot
 */
export { RecordingProcessFactory } from './recording-process-factory.js';
export type { SpawnRecord } from './recording-process-factory.js';
export { normalizeSpawnRecords } from './spawn-snapshot.js';
