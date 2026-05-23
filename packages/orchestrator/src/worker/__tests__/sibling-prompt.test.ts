import { describe, it, expect } from 'vitest';
import { buildSiblingPromptBlock } from '../sibling-prompt.js';

describe('buildSiblingPromptBlock', () => {
  it('returns undefined for empty record', () => {
    expect(buildSiblingPromptBlock({})).toBeUndefined();
  });

  it('formats a single entry', () => {
    const result = buildSiblingPromptBlock({ agency: '/workspaces/agency' });
    expect(result).toBe(
      '**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:\n' +
      '- `agency` — `/workspaces/agency`\n' +
      '\n' +
      'Changes you make in sibling repos will be automatically committed and a draft PR opened, linked to this issue.',
    );
  });

  it('formats multiple entries', () => {
    const result = buildSiblingPromptBlock({
      agency: '/workspaces/agency',
      'generacy-cloud': '/workspaces/generacy-cloud',
    });
    expect(result).toContain('- `agency` — `/workspaces/agency`');
    expect(result).toContain('- `generacy-cloud` — `/workspaces/generacy-cloud`');
    expect(result).toContain('Changes you make in sibling repos will be automatically committed and a draft PR opened, linked to this issue.');
    expect(result!.split('\n').length).toBe(5); // header + 2 entries + blank line + auto-PR sentence
  });

  it('uses the provided name as the identifier regardless of path location', () => {
    const result = buildSiblingPromptBlock({
      'my-repo': '/home/user/projects/my-repo',
    });
    expect(result).toContain('- `my-repo` — `/home/user/projects/my-repo`');
  });
});
