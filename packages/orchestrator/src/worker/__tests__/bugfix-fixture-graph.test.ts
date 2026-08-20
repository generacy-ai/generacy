import { describe, it, expect } from 'vitest';
import {
  loadFixtureGraph,
  affectedSet,
  fullWorkspaceCount,
  assertStrictSubset,
} from './helpers/bugfix-fixture-graph.js';

// ---------------------------------------------------------------------------
// #1135 T007 (US1 / SC-003 / D-3)
//
// Fixture self-check: the synthetic `bugfix-monorepo` dependency graph must keep
// `affected(core) ⊊ workspace` a STRICT subset. If a future fixture edit ever
// widens the closure to the whole workspace, the targeted-validate scenarios would
// silently stop distinguishing "targeted" from "full" — so fail loudly here.
// ---------------------------------------------------------------------------

describe('bugfix-monorepo fixture graph (#1135 T007)', () => {
  const graph = loadFixtureGraph();

  it('has the five-package workspace from data-model §1', () => {
    expect(graph.packages).toEqual(['a', 'b', 'core', 'docs', 'util']);
    expect(fullWorkspaceCount(graph)).toBe(5);
  });

  it('encodes the hand-authored dependency edges (a→core, b→a)', () => {
    expect(graph.dependsOn.core).toEqual([]);
    expect(graph.dependsOn.a).toEqual(['core']);
    expect(graph.dependsOn.b).toEqual(['a']);
    expect(graph.dependsOn.util).toEqual([]);
    expect(graph.dependsOn.docs).toEqual([]);
  });

  it('affected(core) = {core, a, b} — transitive dependents only', () => {
    expect(affectedSet(graph, ['core'])).toEqual(['a', 'b', 'core']);
  });

  it('affected(core) count is STRICTLY fewer than the full workspace (SC-003)', () => {
    const affected = affectedSet(graph, ['core']);
    expect(affected.length).toBeLessThan(fullWorkspaceCount(graph));
    expect(() => assertStrictSubset(graph, ['core'])).not.toThrow();
  });

  it('assertStrictSubset throws if the closure widens to the whole workspace', () => {
    // `util` and `docs` are independent; changing all three leaf roots would still
    // not cover the workspace — but changing a package every other depends on would.
    // Simulate the failure mode by asserting against a synthetic full-closure change.
    expect(() => assertStrictSubset(graph, graph.packages)).toThrow(
      /strict-subset invariant violated/,
    );
  });
});
