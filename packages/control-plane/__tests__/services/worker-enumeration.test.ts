/**
 * Smoke test for the #714 worker-enumeration extraction.
 *
 * Confirms `WorkerReplica`, `computeProjectName`, and `enumerateWorkers` are
 * importable from both the new module (`./services/worker-enumeration.js`)
 * and the package's public surface (`src/index.ts`, which the build emits as
 * `@generacy-ai/control-plane`). Behavioral coverage stays in
 * `worker-scaler.test.ts`; this file is intentionally thin.
 */

import { describe, it, expect } from 'vitest';
import {
  computeProjectName as cpnFromModule,
  enumerateWorkers as enumFromModule,
  type WorkerReplica as WorkerReplicaFromModule,
} from '../../src/services/worker-enumeration.js';
import {
  computeProjectName as cpnFromIndex,
  enumerateWorkers as enumFromIndex,
  type WorkerReplica as WorkerReplicaFromIndex,
} from '../../src/index.js';

describe('worker-enumeration exports (#714)', () => {
  it('exports computeProjectName as a function from both paths', () => {
    expect(typeof cpnFromModule).toBe('function');
    expect(typeof cpnFromIndex).toBe('function');
    // Same binding — the index just re-exports.
    expect(cpnFromIndex).toBe(cpnFromModule);
  });

  it('exports enumerateWorkers as a function from both paths', () => {
    expect(typeof enumFromModule).toBe('function');
    expect(typeof enumFromIndex).toBe('function');
    expect(enumFromIndex).toBe(enumFromModule);
  });

  it('WorkerReplica type is structurally usable from both import sites', () => {
    // Compile-time only: assigning one to the other proves the structural
    // shape matches. The runtime expect keeps the test from being elided.
    const replica: WorkerReplicaFromModule = {
      id: 'c1',
      number: 1,
      name: 'p-worker-1',
      state: 'running',
      networkIds: [],
    };
    const sameReplica: WorkerReplicaFromIndex = replica;
    expect(sameReplica.state).toBe('running');
  });
});
