/**
 * Default cluster-name generator for `generacy launch`.
 *
 * Counts local-mode registry entries scoped to a single project and emits the
 * smallest `<sanitized-project>-local-<n>` not yet in use.
 */
import type { Registry } from './registry.js';
import { sanitizeProjectComponent } from './name-normalize.js';

export function generateDefaultName(
  projectId: string,
  projectName: string,
  registry: Registry,
): string {
  const project = sanitizeProjectComponent(projectName);
  const taken = new Set<string>(
    registry
      .filter(
        (e) =>
          e.projectId === projectId &&
          (e.deploymentMode ?? 'local') === 'local' &&
          typeof e.displayName === 'string' &&
          e.displayName.length > 0,
      )
      .map((e) => e.displayName as string),
  );

  for (let n = 1; ; n++) {
    const candidate = `${project}-local-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
