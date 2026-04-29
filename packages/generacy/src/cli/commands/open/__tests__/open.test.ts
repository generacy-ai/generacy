import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/cluster-context.js', () => ({
  getClusterContext: vi.fn(),
}));

vi.mock('../../../utils/browser.js', () => ({
  openUrl: vi.fn(),
}));

import { getClusterContext } from '../../../utils/cluster-context.js';
import { openUrl } from '../../../utils/browser.js';
import { openCommand } from '../index.js';

const mockedGetClusterContext = vi.mocked(getClusterContext);
const mockedOpenUrl = vi.mocked(openUrl);

describe('openCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('constructs correct URL and opens it', async () => {
    mockedGetClusterContext.mockResolvedValue({
      clusterId: 'my-cluster',
      projectId: 'proj_abc',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      generacyDir: '/home/user/project/.generacy',
      projectDir: '/home/user/project',
    });

    const cmd = openCommand();
    await cmd.parseAsync(['node', 'generacy', 'open']);

    expect(mockedGetClusterContext).toHaveBeenCalledWith({ clusterId: undefined });
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://api.generacy.ai/clusters/my-cluster');
  });

  it('passes --cluster option to getClusterContext', async () => {
    mockedGetClusterContext.mockResolvedValue({
      clusterId: 'specific-cluster',
      projectId: 'proj_def',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      generacyDir: '/home/user/other/.generacy',
      projectDir: '/home/user/other',
    });

    const cmd = openCommand();
    await cmd.parseAsync(['node', 'generacy', 'open', '--cluster', 'specific-cluster']);

    expect(mockedGetClusterContext).toHaveBeenCalledWith({ clusterId: 'specific-cluster' });
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://api.generacy.ai/clusters/specific-cluster');
  });

  it('throws when cluster not found', async () => {
    mockedGetClusterContext.mockRejectedValue(
      new Error("Cluster 'bad-id' not found in registry. Run 'generacy status' to see available clusters."),
    );

    const cmd = openCommand();
    await expect(
      cmd.parseAsync(['node', 'generacy', 'open', '--cluster', 'bad-id']),
    ).rejects.toThrow("Cluster 'bad-id' not found in registry");
  });
});
