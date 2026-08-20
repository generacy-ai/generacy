/**
 * #1135 phase-4 integration harness — synthetic-fixture dependency graph reader.
 *
 * Reads the checked-in `bugfix-monorepo` fixture (data-model §1) and derives the
 * affected-package closure for a changed set. This is what lets the harness turn a
 * targeted validate command into a deterministic per-suite execution count without
 * shelling out to pnpm: `affected = changed ∪ transitive-dependents(changed)`.
 *
 * The strict-subset invariant (D-3 / SC-003) — `affected({core}) ⊊ workspace` — is
 * a pure property of the checked-in package.json graph; `assertStrictSubset` fails
 * loudly if a future fixture edit widens the closure to the whole workspace.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the checked-in synthetic monorepo fixture. */
export const FIXTURE_ROOT = join(HERE, '..', 'fixtures', 'bugfix-monorepo');

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
}

export interface FixtureGraph {
  /** All workspace package names (unqualified short keys: core/a/b/util/docs). */
  packages: string[];
  /** short name → full package name (e.g. `core` → `@fixture/core`). */
  fullName: Record<string, string>;
  /** short name → short names it directly depends on. */
  dependsOn: Record<string, string[]>;
}

/** short package name → the fixture path segment under `packages/`. */
function shortName(fullName: string): string {
  return fullName.replace(/^@fixture\//, '');
}

/**
 * Load the fixture's package graph from disk. Pure read; no pnpm invocation.
 */
export function loadFixtureGraph(root: string = FIXTURE_ROOT): FixtureGraph {
  const packagesDir = join(root, 'packages');
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const fullName: Record<string, string> = {};
  const dependsOn: Record<string, string[]> = {};
  const packages: string[] = [];

  for (const dir of dirs) {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const short = shortName(manifest.name);
    packages.push(short);
    fullName[short] = manifest.name;
    dependsOn[short] = Object.keys(manifest.dependencies ?? {})
      .filter((d) => d.startsWith('@fixture/'))
      .map(shortName);
  }

  packages.sort();
  return { packages, fullName, dependsOn };
}

/**
 * Compute the affected-package closure for a changed set: the changed packages plus
 * every package that transitively depends on any changed package (the pnpm
 * `...[ref]` "dependents" semantics the targeted validate command encodes).
 */
export function affectedSet(graph: FixtureGraph, changed: string[]): string[] {
  const affected = new Set<string>(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of graph.packages) {
      if (affected.has(pkg)) continue;
      if (graph.dependsOn[pkg]?.some((dep) => affected.has(dep))) {
        affected.add(pkg);
        grew = true;
      }
    }
  }
  return [...affected].sort();
}

/** Full-workspace count = every package a full validate would run. */
export function fullWorkspaceCount(graph: FixtureGraph): number {
  return graph.packages.length;
}

/**
 * Assert the affected closure for `changed` is a STRICT subset of the workspace —
 * the SC-003 invariant. Throws with a descriptive message if the closure ever
 * widens to cover the whole workspace (a future fixture edit that would silently
 * defeat the targeted-validate scenarios).
 */
export function assertStrictSubset(graph: FixtureGraph, changed: string[]): void {
  const affected = affectedSet(graph, changed);
  const full = fullWorkspaceCount(graph);
  if (affected.length >= full) {
    throw new Error(
      `Fixture strict-subset invariant violated: affected(${JSON.stringify(changed)}) = ` +
        `${JSON.stringify(affected)} (count ${affected.length}) is not strictly fewer than ` +
        `the ${full}-package workspace ${JSON.stringify(graph.packages)}.`,
    );
  }
}
