import path from 'node:path';

/**
 * Builds a markdown instruction block listing sibling repos.
 * Returns undefined when the list is empty (no block emitted).
 */
export function buildSiblingPromptBlock(workdirs: string[]): string | undefined {
  if (!workdirs.length) return undefined;
  const lines = workdirs.map(
    (dir) => `- \`${path.basename(dir)}\` — \`${dir}\``,
  );
  return [
    '**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:',
    ...lines,
  ].join('\n');
}
