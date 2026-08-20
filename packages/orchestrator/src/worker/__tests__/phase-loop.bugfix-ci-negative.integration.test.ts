/**
 * T016 (#1135, US1) — speckit-bugfix CI merge-readiness negative variants.
 *
 * Drives `PhaseLoop.executeLoop` at the `validate` phase with #1133's CI merge
 * gate enabled, proving that a run whose CI never actually executed does NOT
 * satisfy the post-validate `implementation-review` final gate:
 *
 *   - validate green + CI **skipped-only** — `aggregateCiVerdict` drops
 *     `skipped` runs, the effective verdict is `pending`, the readiness wait
 *     times out, and the loop pauses on `waiting-for:ci`. The
 *     `implementation-review` gate is NEVER raised (SC-004).
 *   - validate green + CI **neutral-only** — same story: `neutral` is dropped,
 *     verdict `pending`, `waiting-for:ci` pause, no `implementation-review`.
 *
 * The green-both-pass positive (final gate DOES raise) lives in T013.
 *
 * Ships NO product behavior (#1135 FR-010): consumes the already-merged #1133
 * merge-readiness evaluation through the harness, mocking only external
 * boundaries. Every variant asserts an explicit suite-execution count (FR-006).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PhaseLoop,
  getPhaseSequence,
  createBugfixDeps,
  createBugfixContext,
  createBugfixConfig,
  bugfixSettings,
  onCiGreenGate,
  SuiteLedger,
  loadFixtureGraph,
  affectedSet,
  CI,
  mockLogger,
  type WorkflowPhase,
} from './helpers/bugfix-harness.js';

const TARGETED_COMMAND =
  'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test';

const CHANGED = ['packages/core/src/x.ts'];

describe('#1135 T016 — speckit-bugfix CI merge-readiness negative variants (US1)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger as unknown as ConstructorParameters<typeof PhaseLoop>[0]);
  });

  // FR-007 / SC-004 — a `skipped`-only CI result is NOT green: the verdict
  // aggregates to `pending`, the readiness wait times out, and the final
  // `implementation-review` gate is never raised.
  it('validate green + skipped-only CI: final gate NOT raised — pauses on waiting-for:ci (SC-004)', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({
      gates: onCiGreenGate(),
      ledger,
      graph,
      changedFiles: CHANGED,
      settings: bugfixSettings(),
    });
    const context = createBugfixContext({
      changedFiles: CHANGED,
      ciRuns: CI.skippedOnly(),
      issueLabels: [],
      startPhase: 'validate',
    });
    const config = createBugfixConfig({ ciMergeGateEnabled: true });
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // The targeted validate still ran once with the affected-set count.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(TARGETED_COMMAND);
    expect(ledger.testRuns('branch')).toHaveLength(affectedSet(graph, ['core']).length);

    // Load-bearing negative: the post-validate final gate is NEVER raised
    // because CI is not green (skipped ≠ passed).
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );

    // Instead the loop pauses on the CI-readiness gate.
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('validate');
  });

  // FR-007 / SC-004 — a `neutral`-only CI result is likewise dropped from the
  // aggregate; verdict `pending` → `waiting-for:ci` pause → no final gate.
  it('validate green + neutral-only CI: final gate NOT raised — pauses on waiting-for:ci (SC-004)', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({
      gates: onCiGreenGate(),
      ledger,
      graph,
      changedFiles: CHANGED,
      settings: bugfixSettings(),
    });
    const context = createBugfixContext({
      changedFiles: CHANGED,
      ciRuns: CI.neutralOnly(),
      issueLabels: [],
      startPhase: 'validate',
    });
    const config = createBugfixConfig({ ciMergeGateEnabled: true });
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(TARGETED_COMMAND);
    expect(ledger.testRuns('branch')).toHaveLength(affectedSet(graph, ['core']).length);

    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );

    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('validate');
  });
});
