/**
 * T013 (#1135, US1) — speckit-bugfix profile end-to-end happy path.
 *
 * Drives `PhaseLoop.executeLoop` through the whole P4 composition against the
 * checked-in synthetic monorepo fixture:
 *
 *   implement
 *     → verification review (round 1: blocking "missing regression test")
 *       → remediate (adds the test, off-sequence)
 *         → clean re-review (round 2) → markReadyForReview
 *           → targeted validate ∥ injected green CI
 *             → post-validate `implementation-review` final gate
 *
 * This suite ships NO product behavior (#1135 FR-010): it consumes the already
 * merged #1133 (CI merge readiness) and #1134 (targeted validate / diff
 * classification / verification charter) seams and mocks only the external
 * boundaries (GitHub, CLI spawner, findings artifact). Every variant asserts an
 * explicit suite-execution count (FR-006).
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
  missingRegressionTestArtifact,
  phaseStartOrder,
  SuiteLedger,
  loadFixtureGraph,
  affectedSet,
  fullWorkspaceCount,
  CI,
  mockLogger,
  type WorkflowPhase,
} from './helpers/bugfix-harness.js';
import { resolveWorkflowOverrides } from '../config.js';

describe('#1135 T013 — speckit-bugfix profile end-to-end happy path (US1)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger as unknown as ConstructorParameters<typeof PhaseLoop>[0]);
  });

  // AC1 — the verification charter is selected for speckit-bugfix, not feature.
  // The charter choice is observable through the resolver seam (Q4=B pattern):
  // it is NOT a WorkerConfig field or an injected loop dependency.
  it('selects the verification review profile for speckit-bugfix, not the feature default (AC1)', () => {
    const config = createBugfixConfig({ ciMergeGateEnabled: true });
    const settings = bugfixSettings();

    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');

    expect(resolved.review.profile).toBe('verification');
    expect(resolved.review.blockingSeverity).toBe('critical');
    // Bugfix caps remediations at 2 (built-in default).
    expect(resolved.maxRemediations).toBe(2);
    // Not a WorkerConfig field, not a loop dep.
    expect('review' in config).toBe(false);
    expect('maxRemediations' in config).toBe(false);
  });

  // AC2 + AC3/AC4 + AC5 + AC6 — the full happy path in one drive.
  it('routes a blocking finding through remediate, re-reviews clean, runs targeted validate, and raises the final gate only with green CI (AC2/AC3/AC4/AC5/AC6)', async () => {
    const graph = loadFixtureGraph();
    const changedFiles = ['packages/core/src/x.ts'];
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({
      verdictByRound: missingRegressionTestArtifact, // round 1 blocking, round 2 clean
      gates: onCiGreenGate(),
      ledger,
      graph,
      changedFiles,
      settings: bugfixSettings(),
    });
    const context = createBugfixContext({
      changedFiles,
      ciRuns: CI.green(),
      issueLabels: [], // gate not pre-satisfied → it can actually raise
      startPhase: 'implement',
    });
    const config = createBugfixConfig({ ciMergeGateEnabled: true });
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // AC2 — remediate is entered off-sequence exactly once (round 1 blocking),
    // then control returns to a clean re-review before advancing.
    const order = phaseStartOrder(deps);
    expect(order).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    expect(sequence).not.toContain('remediate');
    const remediateIdx = order.indexOf('remediate');
    expect(order[remediateIdx + 1]).toBe('review');
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('remediate');

    // AC6 — the remediation counter converges before the cap of 2: exactly one
    // remediate cycle fired (round 2 verdict is clean), well under maxRemediations.
    const remediateStarts = order.filter((p) => p === 'remediate').length;
    expect(remediateStarts).toBe(1);
    expect(remediateStarts).toBeLessThan(resolveWorkflowOverrides(config, bugfixSettings(), 'speckit-bugfix').maxRemediations);

    // AC3/AC4 — validate is narrowed to the targeted affected-set closure.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(
      'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test',
    );

    // SC-003 — suite-execution count equals the affected set and is strictly
    // fewer than the full workspace. A `core` change → {core, a, b} = 3 < 5.
    const affected = affectedSet(graph, ['core']);
    expect(affected).toEqual(['a', 'b', 'core']);
    expect(ledger.testRuns('branch')).toHaveLength(affected.length);
    expect(ledger.testRuns('branch').length).toBeLessThan(fullWorkspaceCount(graph));
    expect(ledger.testedSuites('branch')).toEqual(['a', 'b', 'core']);
    // No base-ref runs (failThenPass off by default).
    expect(ledger.byRef('base')).toHaveLength(0);

    // AC5 — with validate green AND CI green, the post-validate
    // `implementation-review` final gate is raised: the loop pauses.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(result.lastPhase).toBe('validate');
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );
    // on-ci-green special case: validate is marked complete before the gate raise.
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('validate');
  });

  // AC5 control — the final gate requires BOTH validate and green CI. With
  // validate green but CI not passing, the `on-ci-green` gate stays inactive and
  // the loop advances without raising `implementation-review`.
  it('does NOT raise the final gate when validate is green but CI is not passing (AC5, FR-007)', async () => {
    const graph = loadFixtureGraph();
    const changedFiles = ['packages/core/src/x.ts'];
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({
      verdictByRound: missingRegressionTestArtifact,
      gates: onCiGreenGate(),
      ledger,
      graph,
      changedFiles,
      settings: bugfixSettings(),
    });
    const context = createBugfixContext({
      changedFiles,
      ciRuns: CI.failing(), // [failure, success] → not-passed
      issueLabels: [],
      startPhase: 'implement',
    });
    const config = createBugfixConfig({ ciMergeGateEnabled: true });
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // Gate inactive → loop completes normally, no implementation-review raise.
    expect(result.gateHit).toBe(false);
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );

    // The targeted validate still ran once with the same affected-set count.
    expect(deps.validateCommands).toHaveLength(1);
    expect(ledger.testRuns('branch')).toHaveLength(affectedSet(graph, ['core']).length);
  });
});
