/**
 * T015 (#1135, US3) — speckit-bugfix opt-in fail-then-pass regression proof.
 *
 * Drives `PhaseLoop.executeLoop` at the `validate` phase with #1134's opt-in
 * `failThenPass` toggle, proving the regression-proof seam composes with the
 * targeted-validate classifier — and, crucially, that the REAL base-fail /
 * branch-pass regression semantics hold (clarifications Q3=A). Rather than stub
 * the whole `runFailThenPass` with a canned outcome, the scenarios exercise the
 * real logic and mock only its external boundary: the git/pnpm `execFile` spawns
 * (`node:child_process`) and the fs overlay (`node:fs/promises`). The vitest run
 * is the "validate seam" — keyed on (command, ref) where `ref` is the spawn cwd
 * (base worktree vs branch checkout) — and returns the injected pass/fail:
 *
 *   - `failThenPass` ON, fail@base + pass@branch — the changed test file is
 *     executed against the BASE ref (recorded FAIL) and the branch (recorded
 *     PASS); the real proof passes and the targeted validate then runs. The
 *     suite-execution count INCLUDES the extra base-ref run (SC-005).
 *   - `failThenPass` ON, pass@base — a test that PASSES on the base ref does NOT
 *     reproduce the bug. The REAL logic must reject it as `base-passed`: it
 *     short-circuits (the branch run never happens), fails the gate, so ZERO
 *     validate commands run and the phase does not complete. A regression that
 *     accepted pass@base would let this scenario complete and fail the test.
 *   - `failThenPass` OFF (default) — no base-ref execution at all; the seam is
 *     never touched and validate runs the targeted command directly.
 *
 * Ships NO product behavior (#1135 FR-010): the only mocks are the process/fs
 * boundaries; the #1134 regression logic itself is real. Every variant asserts
 * an explicit suite-execution count (FR-006).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
// Values that the harness merely RE-EXPORTS (`PhaseLoop`, `getPhaseSequence`,
// `loadFixtureGraph`, `affectedSet`) are imported DIRECTLY from their source
// modules here. Mocking both `node:*` builtins below shifts module-init order
// enough that the harness barrel's re-exported bindings resolve in a
// temporal-dead-zone (circular-init edge) and come back `undefined`; the source
// modules themselves initialize fine. Harness-OWNED definitions (functions/
// classes/consts declared in the barrel) are unaffected and imported normally.
import { PhaseLoop } from '../phase-loop.js';
import { getPhaseSequence } from '../types.js';
import { loadFixtureGraph, affectedSet } from './helpers/bugfix-fixture-graph.js';
import {
  createBugfixDeps,
  createBugfixContext,
  createBugfixConfig,
  bugfixSettings,
  SuiteLedger,
  failThenPass,
  mockLogger,
  type WorkflowPhase,
} from './helpers/bugfix-harness.js';

// Exercise the REAL `runFailThenPass` (#1134). Mock only its external boundary:
// the git/pnpm `execFile` spawns and the fs overlay. Both delegate to the shared
// validate-seam controller (imports are hoist-safe inside vi.mock factories).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) =>
      (failThenPass.execFile as unknown as (...a: unknown[]) => void)(...args),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Reference the controller lazily (inside arrows) — a vi.mock factory is
  // hoisted above the harness import, so eager access would read an uninitialized
  // binding. The controller's overrides are only ever hit by `runFailThenPass`.
  return {
    ...actual,
    mkdtemp: (...args: unknown[]) =>
      (failThenPass.mkdtemp as unknown as (...a: unknown[]) => unknown)(...args),
    mkdir: (...args: unknown[]) =>
      (failThenPass.mkdir as unknown as (...a: unknown[]) => unknown)(...args),
    copyFile: (...args: unknown[]) =>
      (failThenPass.copyFile as unknown as (...a: unknown[]) => unknown)(...args),
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

  // FR-005 — with `failThenPass` ON and the injected seam returning fail@base +
  // pass@branch, the REAL proof passes: the changed test file is executed against
  // the base ref (recorded FAIL) and the branch (recorded PASS), then the
  // targeted validate proceeds. Count INCLUDES the extra base-ref run.
  it('failThenPass ON: fail@base + pass@branch proves the regression, then runs targeted validate (SC-005)', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();
    failThenPass.ledger = ledger;
    // Seed the validate seam: fail on the base ref, pass on the branch.
    failThenPass.outcomes = { base: 'fail', branch: 'pass' };

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

    // The regression proof ran the changed test file against BOTH refs, in order.
    expect(failThenPass.baseRuns().map((r) => r.files)).toEqual([[CHANGED_TEST_FILE]]);
    expect(failThenPass.branchRuns().map((r) => r.files)).toEqual([[CHANGED_TEST_FILE]]);

    // The load-bearing regression semantics: the base run is recorded as FAIL and
    // the branch run as PASS — not a canned outcome. This is what proves the
    // changed test reproduces the bug at base and is resolved by the fix.
    expect(ledger.testRuns('base')).toEqual([
      { suite: CHANGED_TEST_FILE, kind: 'test', ref: 'base', outcome: 'fail' },
    ]);
    const ftpBranch = ledger.testRuns('branch').filter((r) => r.outcome !== undefined);
    expect(ftpBranch).toEqual([
      { suite: CHANGED_TEST_FILE, kind: 'test', ref: 'branch', outcome: 'pass' },
    ]);

    // The proof passed → the targeted validate runs verbatim afterward.
    expect(deps.validateCommands).toEqual([TARGETED_COMMAND]);

    // SC-005 — the base-ref execution is the load-bearing extra count. Branch-side
    // count = fail-then-pass branch run (1) + targeted affected-set test runs
    // ({core,a,b} = 3). The base run makes the grand total strictly larger than a
    // plain targeted validate.
    const affected = affectedSet(graph, ['core']);
    expect(affected).toEqual(['a', 'b', 'core']);
    expect(ledger.byRef('base')).toHaveLength(1);
    expect(ledger.testRuns('branch')).toHaveLength(1 + affected.length);
    expect(ledger.testRuns()).toHaveLength(ledger.testRuns('branch').length + 1);

    expect(result.completed).toBe(true);
  });

  // FR-005 negative — with `failThenPass` ON but the changed test PASSING on the
  // base ref, the REAL logic must reject it as `base-passed`: it short-circuits
  // BEFORE the branch run, so the branch run never happens and the failing result
  // short-circuits `runValidatePhase` (`validateResult ?? …`). If the product
  // code regressed to accept pass@base, the branch run would fire, the proof
  // would pass, and validate would run — this test would fail.
  it('failThenPass ON: a test that PASSES on the base ref is rejected (base-passed) — no branch run, zero validate', async () => {
    const graph = loadFixtureGraph();
    const ledger = new SuiteLedger();
    failThenPass.ledger = ledger;
    // Seed the base run to PASS — the changed test does NOT reproduce the bug.
    failThenPass.outcomes = { base: 'pass', branch: 'pass' };

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

    // The seam served exactly one base run, recorded as PASS...
    expect(ledger.testRuns('base')).toEqual([
      { suite: CHANGED_TEST_FILE, kind: 'test', ref: 'base', outcome: 'pass' },
    ]);
    // ...and — crucially — the branch run NEVER happened. The real logic
    // short-circuited on base-passed, so a pass@base was REJECTED, not accepted.
    expect(failThenPass.branchRuns()).toHaveLength(0);
    expect(ledger.testRuns('branch')).toHaveLength(0);

    // Load-bearing short-circuit: a failing fail-then-pass result means
    // `runValidatePhase` is NEVER called — no validate command is spawned.
    expect(deps.validateCommands).toHaveLength(0);

    // The gate failure aborts the phase; the loop does not complete or raise a gate.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('validate');
  });

  // FR-005 default — with `failThenPass` OFF (built-in default), there is NO
  // base-ref execution; the validate seam is never touched, the targeted validate
  // runs directly, and the count omits any base run.
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

    // The regression proof was never invoked — the seam is untouched.
    expect(failThenPass.vitestRuns).toHaveLength(0);
    expect(ledger.byRef('base')).toHaveLength(0);

    // The targeted validate still ran once.
    expect(deps.validateCommands).toEqual([TARGETED_COMMAND]);

    // Branch-side count = targeted affected-set test runs only ({core,a,b} = 3).
    const affected = affectedSet(graph, ['core']);
    expect(ledger.testRuns('branch')).toHaveLength(affected.length);
    expect(ledger.testedSuites('branch')).toEqual(['a', 'b', 'core']);

    expect(result.completed).toBe(true);
  });
});
