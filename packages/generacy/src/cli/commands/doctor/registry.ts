import type { CheckDefinition } from './types.js';

// ---------------------------------------------------------------------------
// CheckRegistry — manages check registration and dependency resolution
// ---------------------------------------------------------------------------

export class CheckRegistry {
  private checks = new Map<string, CheckDefinition>();

  /**
   * Register a health check. Throws if a check with the same ID is already
   * registered.
   */
  register(check: CheckDefinition): void {
    if (this.checks.has(check.id)) {
      throw new Error(`Duplicate check ID: '${check.id}'`);
    }
    this.checks.set(check.id, check);
  }

  /** Return all registered checks (insertion order). */
  getChecks(): CheckDefinition[] {
    return [...this.checks.values()];
  }

  /** Return a registered check by ID, or `undefined` if not found. */
  getCheck(id: string): CheckDefinition | undefined {
    return this.checks.get(id);
  }

  /**
   * Resolve which checks to run and return them in dependency (topological)
   * order.
   *
   * - When `check` is specified, only those checks (and their transitive
   *   dependencies) are included.
   * - When `skip` is specified, those checks are excluded from the result.
   * - Throws on unknown check names in either list.
   * - Throws on circular dependencies.
   */
  resolve(options: { check?: string[]; skip?: string[] } = {}): CheckDefinition[] {
    const { check: includeIds, skip: skipIds } = options;

    // Validate that all referenced IDs exist
    this.validateIds(includeIds, '--check');
    this.validateIds(skipIds, '--skip');

    // Determine the candidate set of checks
    let candidates: Set<string>;

    if (includeIds && includeIds.length > 0) {
      // Start with requested checks, then expand to include all transitive deps
      candidates = this.expandDependencies(includeIds);
    } else {
      candidates = new Set(this.checks.keys());
    }

    // Remove skipped checks
    if (skipIds) {
      for (const id of skipIds) {
        candidates.delete(id);
      }
    }

    // Validate that all dependencies within candidates are satisfied
    this.validateDependencies(candidates);

    // Topological sort the candidates
    return this.topologicalSort(candidates);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Throw if any IDs in the list are not registered. */
  private validateIds(ids: string[] | undefined, flag: string): void {
    if (!ids) return;
    const unknown = ids.filter((id) => !this.checks.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown check${unknown.length > 1 ? 's' : ''} passed to ${flag}: ${unknown.map((id) => `'${id}'`).join(', ')}. ` +
          `Available checks: ${[...this.checks.keys()].join(', ')}`,
      );
    }
  }

  /**
   * Starting from a set of check IDs, expand to include all transitive
   * dependencies.
   */
  private expandDependencies(ids: string[]): Set<string> {
    const result = new Set<string>();
    const stack = [...ids];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (result.has(id)) continue;
      result.add(id);

      const check = this.checks.get(id);
      if (check) {
        for (const dep of check.dependencies) {
          if (!result.has(dep)) {
            stack.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Validate that every dependency referenced by candidates exists within the
   * candidate set. This catches the case where a skipped check is a
   * dependency of an included check.
   */
  private validateDependencies(candidates: Set<string>): void {
    for (const id of candidates) {
      const check = this.checks.get(id)!;
      for (const dep of check.dependencies) {
        if (!this.checks.has(dep)) {
          throw new Error(
            `Check '${id}' depends on '${dep}', which is not registered`,
          );
        }
      }
    }
  }

  /**
   * Kahn's algorithm for topological sort. Detects cycles and throws if one
   * is found.
   *
   * Only considers checks within the `candidates` set.
   */
  private topologicalSort(candidates: Set<string>): CheckDefinition[] {
    // Build in-degree map and adjacency list (within candidates only)
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const id of candidates) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }

    for (const id of candidates) {
      const check = this.checks.get(id)!;
      for (const dep of check.dependencies) {
        if (candidates.has(dep)) {
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
          dependents.get(dep)!.push(id);
        }
      }
    }

    // Seed the queue with all nodes that have zero in-degree
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    // Sort the initial queue for deterministic output (alphabetical)
    queue.sort();

    const sorted: CheckDefinition[] = [];

    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(this.checks.get(id)!);

      // Collect newly freed dependents, then sort for determinism
      const freed: string[] = [];
      for (const dependent of dependents.get(id)!) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          freed.push(dependent);
        }
      }
      freed.sort();
      queue.push(...freed);
    }

    // If we didn't process every candidate, there's a cycle
    if (sorted.length !== candidates.size) {
      const remaining = [...candidates].filter(
        (id) => !sorted.some((c) => c.id === id),
      );
      throw new Error(
        `Circular dependency detected among checks: ${remaining.join(', ')}`,
      );
    }

    return sorted;
  }
}
