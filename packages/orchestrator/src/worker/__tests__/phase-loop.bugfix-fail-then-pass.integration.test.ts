/**
 * T015 (#1135, US3) — speckit-bugfix opt-in fail-then-pass regression proof.
 *
 * Drives `PhaseLoop.executeLoop` at the `validate` phase with #1134's opt-in
 * `failThenPass` toggle, proving the regression-proof seam composes with the
 * targeted-validate classifier:
 *
 *   - `failThenPass` ON, pass-on-branch — the changed test file is executed
 *     against the BASE ref (fail-on-base) and the branch (pass-on-branch); the
 *     targeted validate then runs. The suite-execution count INCLUDES the extra
 *     base-ref run (SC-005).
 *   - `failThenPass` ON, pass-on-base — the regression proof FAILS the gate: the
 *     failing result short-circuits `runValidatePhase` (`validateResult ?? …`),
 *     so ZERO validate commands run and the phase does not complete.
 *   - `failThenPass` OFF (default) — no base-ref execution at all; the count
 *     omits it and validate runs the targeted command directly.
 *
 * Ships NO product behavior (#1135 FR-010): the heavy `runFailThenPass` worktree
 * boundary is the only mock (hoisted), delegating to the shared harness
 * controller. Every variant asserts an explicit suite-execution count (FR-006).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  PhaseLoop,
  getPhaseSequence,
  createBugfixDeps,
  createBugfixContext,
  createBugfixConfig,
  bugfixSettings,
  SuiteLedger,
  loadFixtureGraph,
  affectedSet,
  failThenPass,
  mockLogger,
  type WorkflowPhase,
} from './helpers/bugfix-harness.js';
import type { FailThenPassInput } from '../fail-then-pass.js';

// The real `runFailThenPass` shells out to a git worktree + pnpm install +
// vitest. Replace it with the shared controller so scenarios steer the outcome
// and the base/branch regression runs are recorded deterministically.
vi.mock('../fail-then-pass.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fail-then-pass.js')>();
  return {
    ...actual,
    runFailThenPass: (input: FailThenPassInput) => failThenPass.run(input),
  };
});

const TARGETED_COMMAND =
  'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test';

// A source + test file under the same package → classifier returns `targeted`
// (not `test-only`, because `x.ts` is not a test), so the fail-then-pass seam
// runs alongside the narrowed validate.
const CHANGED = ['packages/core/src/x.ts', 'packages/core/src/__tests__/x.test.ts'];
const CHANGED_TEST_FILE = 'packages/core/src/__tests__/x.test.ts';

describe('#1135 T015 — speckit-bugfix fail-then-pass regression proof (US3)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    failThenPass.reset();
    phaseLoop = new PhaseLoop(mockLogger as unknown as ConstructorParameters<typeof PhaseLoop>[0]);
  });

  // FR-005 — with `failThenPass` ON and the proof passing (fail-on-base /
  // pass-on-branch), the changed test file is executed against the base ref and
  // the targeted validate proceeds. Count INCLUDES the extra base-ref run.
  it('failThenPass ON: runs the changed test against base ref, then targeted validate — count includes the base run (SC-005)', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();
    failThenPass.ledger = ledger;
    failThenPass.outcome = { kind: 'pass' };

    const deps = createBugfixDeps({
      ledger,
      graph,
      changedFiles: CHANGED,
      settings: bugfixSettings({ failThenPass: true }),
    });
    const context = createBugfixContext({ changedFiles: CHANGED, startPhase: 'validate' });
    const config = createBugfixConfig();
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // The regression proof ran exactly once, against the changed test file only.
    expect(failThenPass.spy).toHaveBeenCalledTimes(1);
    const passed = failThenPass.spy.mock.calls[0]![0] as FailThenPassInput;
    expect(passed.changedTestFiles).toEqual([CHANGED_TEST_FILE]);

    // SC-005 — the base-ref execution is the load-bearing extra count.
    expect(ledger.byRef('base')).toHaveLength(1);
    expect(ledger.testRuns('base').map((r) => r.suite)).toEqual([CHANGED_TEST_FILE]);

    // The proof passed → the targeted validate runs verbatim afterward.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(TARGETED_COMMAND);

    // Branch-side count = fail-then-pass branch run (1) + targeted affected-set
    // test runs ({core,a,b} = 3). The base run makes the grand total strictly
    // larger than a plain targeted validate.
    const affected = affectedSet(graph, ['core']);
    expect(affected).toEqual(['a', 'b', 'core']);
    expect(ledger.testRuns('branch')).toHaveLength(1 + affected.length);
    expect(ledger.testRuns()).toHaveLength(ledger.testRuns('branch').length + 1);

    expect(result.completed).toBe(true);
  });

  // FR-005 negative — with `failThenPass` ON but the changed test PASSING on the
  // base ref, the regression proof fails the gate. The failing result
  // short-circuits `runValidatePhase` (`validateResult ?? …`), so validate never
  // runs and the phase does not complete.
  it('failThenPass ON: pass-on-base fails the gate — zero validate commands, phase does not complete', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();
    failThenPass.ledger = ledger;
    failThenPass.outcome = {
      kind: 'fail',
      reason: 'base-passed',
      evidence: 'the regression test passed on the base ref (does not prove the fix)',
    };

    const deps = createBugfixDeps({
      ledger,
      graph,
      changedFiles: CHANGED,
      settings: bugfixSettings({ failThenPass: true }),
    });
    const context = createBugfixContext({ changedFiles: CHANGED, startPhase: 'validate' });
    const config = createBugfixConfig();
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // The proof ran and recorded its base-ref execution.
    expect(failThenPass.spy).toHaveBeenCalledTimes(1);
    expect(ledger.byRef('base')).toHaveLength(1);

    // Explicit suite-execution count (FR-006): the fail-then-pass proof recorded
    // exactly one base run and one branch run; because the failing result
    // short-circuits validate, NO targeted branch runs are added on top.
    expect(ledger.testRuns('base')).toHaveLength(1);
    expect(ledger.testRuns('branch')).toHaveLength(1);

    // Load-bearing short-circuit: a defined (failing) fail-then-pass result means
    // `runValidatePhase` is NEVER called — no validate command is spawned.
    expect(deps.validateCommands).toHaveLength(0);

    // The gate failure aborts the phase; the loop does not complete or raise a gate.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('validate');
  });

  // FR-005 default — with `failThenPass` OFF (built-in default), there is NO
  // base-ref execution; the targeted validate runs directly and the count omits
  // any base run.
  it('failThenPass OFF (default): no base-ref execution — count omits it (SC-005)', async () => {
    const graph = loadFixtureGraph();
    const changedFiles = ['packages/core/src/x.ts'];
    const ledger = new SuiteLedger();
    failThenPass.ledger = ledger;

    const deps = createBugfixDeps({
      ledger,
      graph,
      changedFiles,
      settings: bugfixSettings(), // failThenPass: false
    });
    const context = createBugfixContext({ changedFiles, startPhase: 'validate' });
    const config = createBugfixConfig();
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // The regression proof was never invoked.
    expect(failThenPass.spy).not.toHaveBeenCalled();
    expect(ledger.byRef('base')).toHaveLength(0);

    // The targeted validate still ran once.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(TARGETED_COMMAND);

    // Branch-side count = targeted affected-set test runs only ({core,a,b} = 3).
    const affected = affectedSet(graph, ['core']);
    expect(ledger.testRuns('branch')).toHaveLength(affected.length);
    expect(ledger.testedSuites('branch')).toEqual(['a', 'b', 'core']);

    expect(result.completed).toBe(true);
  });
});
