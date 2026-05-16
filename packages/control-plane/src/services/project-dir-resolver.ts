import fs from 'node:fs/promises';
import path from 'node:path';

let cached: string | null = null;

export function resetGeneracyDirCache(): void {
  cached = null;
}

/**
 * Resolves the .generacy directory path using 4-tier discovery.
 * Result is cached after first successful resolution.
 *
 * Tier 1: GENERACY_PROJECT_DIR env → ${value}/.generacy
 * Tier 2: WORKSPACE_DIR env → ${value}/.generacy
 * Tier 3: readdir('/workspaces') + stat for single .generacy/cluster.yaml match
 * Tier 4: CWD-relative .generacy (backwards compat)
 */
export async function resolveGeneracyDir(): Promise<string> {
  if (cached) return cached;

  // Tier 1: explicit project dir override
  const projectDir = process.env['GENERACY_PROJECT_DIR'];
  if (projectDir) {
    const resolved = path.resolve(projectDir, '.generacy');
    console.log(`[project-dir-resolver] tier 1: GENERACY_PROJECT_DIR → ${resolved}`);
    cached = resolved;
    return resolved;
  }

  // Tier 2: workspace dir convention
  const workspaceDir = process.env['WORKSPACE_DIR'];
  if (workspaceDir) {
    const resolved = path.resolve(workspaceDir, '.generacy');
    console.log(`[project-dir-resolver] tier 2: WORKSPACE_DIR → ${resolved}`);
    cached = resolved;
    return resolved;
  }

  // Tier 3: glob discovery under /workspaces
  try {
    const entries = await fs.readdir('/workspaces', { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join('/workspaces', entry.name, '.generacy', 'cluster.yaml');
      try {
        await fs.stat(candidatePath);
        matches.push(path.join('/workspaces', entry.name, '.generacy'));
      } catch {
        // Not a match — skip
      }
    }

    if (matches.length === 1) {
      const resolved = matches[0]!;
      console.log(`[project-dir-resolver] tier 3: glob discovery → ${resolved}`);
      cached = resolved;
      return resolved;
    }

    if (matches.length > 1) {
      console.warn(
        `[project-dir-resolver] tier 3: multiple .generacy dirs found (${matches.join(', ')}), falling back to CWD`,
      );
    } else {
      console.log('[project-dir-resolver] tier 3: no .generacy dirs found under /workspaces, falling back to CWD');
    }
  } catch {
    console.log('[project-dir-resolver] tier 3: /workspaces not readable, falling back to CWD');
  }

  // Tier 4: CWD-relative (backwards compat)
  const resolved = path.resolve(process.cwd(), '.generacy');
  console.log(`[project-dir-resolver] tier 4: CWD-relative → ${resolved}`);
  cached = resolved;
  return resolved;
}
