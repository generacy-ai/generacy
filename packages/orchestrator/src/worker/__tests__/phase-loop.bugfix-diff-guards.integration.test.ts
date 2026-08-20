/**
 * T014 (#1135, US2) — speckit-bugfix diff-classification guard variants.
 *
 * Two variants on the checked-in synthetic monorepo fixture, each isolating the
 * targeted-validate resolution (#1134) at the `validate` phase:
 *
 *   - Root-config diff (root lockfile / workspace file / base tsconfig / CI
 *     workflow) → classifier forces `full-fallback` → the built-in default runs
 *     verbatim across the WHOLE workspace (SC-004).
 *   - Docs-only diff → classifier returns `docs-only-skip-tests` → build-only
 *     command, ZERO test suite executions (SC-004).
 *
 * Ships NO product behavior (#1135 FR-010): drives the already-merged #1134
 * classifier through `resolveTargetedValidate`, mocking only the external
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
  SuiteLedger,
  loadFixtureGraph,
  affectedSet,
  fullWorkspaceCount,
  DEFAULT_VALIDATE_COMMAND,
  mockLogger,
  type WorkflowPhase,
} from './helpers/bugfix-harness.js';

describe('#1135 T014 — speckit-bugfix diff-classification guards (US2)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger as unknown as ConstructorParameters<typeof PhaseLoop>[0]);
  });

  // FR-003 — a root-config change forces the classifier onto `full-fallback`, so
  // the built-in default validate command runs UN-narrowed across every package.
  it('root-config diff falls back to the full validate command — count = full workspace (SC-004)', async () => {
    const graph = loadFixtureGraph();
    const changedFiles = ['pnpm-lock.yaml']; // root lockfile → root-config guard
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({ ledger, graph, changedFiles, settings: bugfixSettings() });
    const context = createBugfixContext({ changedFiles, startPhase: 'validate' });
    const config = createBugfixConfig();
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // The default command is NOT narrowed — it runs verbatim.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe(DEFAULT_VALIDATE_COMMAND);

    // SC-004 — full-fallback executes the WHOLE workspace, not the affected subset.
    const full = [...graph.packages].sort();
    expect(ledger.testRuns('branch')).toHaveLength(fullWorkspaceCount(graph));
    expect(ledger.testedSuites('branch')).toEqual(full);
    // Sanity: the full set is strictly larger than a `core` affected closure (3).
    expect(ledger.testRuns('branch').length).toBeGreaterThan(affectedSet(graph, ['core']).length);
    // No base-ref runs (failThenPass off by default).
    expect(ledger.byRef('base')).toHaveLength(0);

    expect(result.completed).toBe(true);
  });

  // FR-004 — a docs-only change resolves to the build-only command; the classifier
  // deliberately skips the test half, so ZERO test suites execute.
  it('docs-only diff skips tests — test suite-execution count = 0 (SC-004)', async () => {
    const graph = loadFixtureGraph();
    const changedFiles = ['packages/docs/README.md']; // *.md → docs guard
    const ledger = new SuiteLedger();

    const deps = createBugfixDeps({ ledger, graph, changedFiles, settings: bugfixSettings() });
    const context = createBugfixContext({ changedFiles, startPhase: 'validate' });
    const config = createBugfixConfig();
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // Build-only narrowed command — the test half is dropped.
    expect(deps.validateCommands).toHaveLength(1);
    expect(deps.validateCommands[0]).toBe('pnpm --filter "...[origin/develop]" build');

    // SC-004 — the load-bearing assertion: docs-only runs NO tests.
    expect(ledger.testRuns('branch')).toHaveLength(0);
    // Builds still run for the docs affected closure (just `docs`, which has no dependents).
    expect(ledger.buildRuns('branch')).toHaveLength(affectedSet(graph, ['docs']).length);
    expect(ledger.byRef('base')).toHaveLength(0);

    expect(result.completed).toBe(true);
  });
});
