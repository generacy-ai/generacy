import { describe, it, expect } from 'vitest';
import { buildSiblingPromptBlock } from '../sibling-prompt.js';

describe('buildSiblingPromptBlock', () => {
  it('returns undefined for empty array', () => {
    expect(buildSiblingPromptBlock([])).toBeUndefined();
  });

  it('formats a single path with basename', () => {
    const result = buildSiblingPromptBlock(['/workspaces/agency']);
    expect(result).toBe(
      '**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:\n' +
      '- `agency` — `/workspaces/agency`',
    );
  });

  it('formats multiple paths', () => {
    const result = buildSiblingPromptBlock([
      '/workspaces/agency',
      '/workspaces/generacy-cloud',
    ]);
    expect(result).toContain('- `agency` — `/workspaces/agency`');
    expect(result).toContain('- `generacy-cloud` — `/workspaces/generacy-cloud`');
    expect(result!.split('\n').length).toBe(3); // header + 2 entries
  });

  it('extracts basename from nested directory paths', () => {
    const result = buildSiblingPromptBlock(['/home/user/projects/my-repo']);
    expect(result).toContain('- `my-repo` — `/home/user/projects/my-repo`');
  });
});
