/**
 * #1043 Finding 3: branch/PR enumeration must not be silently capped at
 * GitHub's default page size (30). A `<N>-*` branch past page 1 would be
 * dropped, the issue-branch resolver would return null, and createFeature
 * would fork a fresh divergent branch — reintroducing the duplicate-PR bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }),
}));

import { executeCommand } from '../../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient enumeration pagination (#1043 Finding 3)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('listBranches paginates the /branches API — branches beyond the first 30 are returned', async () => {
    // 45 branches: more than GitHub's 30-per-page default. With `--paginate`
    // + per_page=100 gh emits them all in one concatenated stdout.
    const names = Array.from({ length: 45 }, (_, i) => `${1000 + i}-feature-${i}`);
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: names.join('\n') + '\n',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const branches = await client.listBranches('acme', 'widgets');

    expect(branches).toHaveLength(45);
    // A branch that would live on page 2 under the default page size.
    expect(branches).toContain('1044-feature-44');

    // Assert the request actually opts into pagination.
    const call = mockExecuteCommand.mock.calls[0]!;
    const cmd = call[0] as string;
    const args = call[1] as string[];
    expect(cmd).toBe('gh');
    expect(args).toContain('--paginate');
    expect(args.some((a) => a.includes('per_page=100'))).toBe(true);
    expect(args.some((a) => a.includes('/repos/acme/widgets/branches'))).toBe(true);
  });

  it('listOpenPullRequests raises the --limit cap well above the default', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '[]',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await client.listOpenPullRequests('acme', 'widgets');

    const args = mockExecuteCommand.mock.calls[0]![1] as string[];
    const limitIdx = args.indexOf('--limit');
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(Number(args[limitIdx + 1])).toBeGreaterThanOrEqual(1000);
  });
});
