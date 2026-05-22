/**
 * Builds a markdown instruction block listing sibling repos.
 * Returns undefined when the list is empty (no block emitted).
 */
export function buildSiblingPromptBlock(
  workdirs: Record<string, string>,
): string | undefined {
  const entries = Object.entries(workdirs);
  if (entries.length === 0) return undefined;
  const lines = entries.map(([name, dir]) => `- \`${name}\` — \`${dir}\``);
  return [
    '**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:',
    ...lines,
  ].join('\n');
}
