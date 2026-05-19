# Clarifications for #427: Spawn Snapshot Test Harness

## Batch 1 — 2026-04-12

### Q1: stdio field in spawn records
**Context**: The spec requires capturing `stdio` config in spawn records (FR-001, FR-005, SC-004), but the `ProcessFactory.spawn` interface only accepts `{cwd, env, signal?}`. The `stdio` configuration is hardcoded inside each factory implementation (`['ignore', 'pipe', 'pipe']` for worker, `['pipe', 'pipe', 'pipe']` for conversation) and is invisible to the caller.
**Question**: How should the RecordingProcessFactory handle stdio capture when it's not part of the ProcessFactory interface?
**Options**:
- A: Remove stdio from capture requirements — it's an implementation detail of each factory, not a spawn argument the spawner controls
- B: Add a configurable stdio field to RecordingProcessFactory constructor that gets included in records (simulated, not from interface)
- C: Extend ProcessFactory interface to include stdio (contradicts out-of-scope constraint)

**Answer**: *Pending*

### Q2: Environment variable snapshot scope
**Context**: `cli-spawner.spawnPhase` passes `options.env` (the override set only) to `ProcessFactory.spawn`. Real factory implementations then merge this with `process.env` internally (`{...process.env, ...options.env}`). The merge strategy is invisible to the RecordingProcessFactory since it only sees what the spawner passes.
**Question**: Is capturing only the override env set sufficient for parity testing? If a Wave 3 refactoring changes the env merge strategy inside the factory, that regression wouldn't be caught by spawn-argument snapshots.
**Options**:
- A: Override env only is sufficient — the snapshot tests the spawner's behavior, not the factory's merge logic
- B: The harness should also verify the full merged env (requires a different testing approach)

**Answer**: *Pending*

### Q3: Non-deterministic field sanitization
**Context**: FR-004 (P2) specifies that `assertSpawnSnapshot()` should "sanitize non-deterministic fields (timestamps, PIDs) before comparison". However, the RecordingProcessFactory controls all recorded values — PID can be hardcoded (like the existing mock's `12345`), and there are no timestamps in spawn records. The only potential instability is env var ordering.
**Question**: Should the initial implementation include a sanitization/normalization layer, or is sorting env keys sufficient for now?
**Options**:
- A: Just sort env keys for deterministic ordering; defer further sanitization until a real need arises in Waves 2-3
- B: Build the sanitization framework now (removable fields, regex replacements) for forward-compatibility

**Answer**: *Pending*
