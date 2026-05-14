import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(() => true),
}));

vi.mock('../../../../utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../../utils/exec.js', () => ({
  execSafe: vi.fn(() => ({ ok: true, stdout: 'Docker version 27.0.3', stderr: '' })),
}));

vi.mock('../../../../utils/node-version.js', () => ({
  checkNodeVersion: vi.fn(),
}));

const mockClearStaleActivation = vi.fn().mockReturnValue(true);
vi.mock('../volume-cleanup.js', () => ({
  clearStaleActivation: mockClearStaleActivation,
}));

vi.mock('../scaffolder.js', () => ({
  scaffoldProject: vi.fn(),
  resolveProjectDir: vi.fn((_name: string, dir?: string) => dir ?? '/tmp/test-project'),
}));

vi.mock('../prompts.js', () => ({
  promptClaimCode: vi.fn().mockResolvedValue('test-claim'),
  confirmDirectory: vi.fn().mockResolvedValue(true),
}));

vi.mock('../cloud-client.js', () => ({
  fetchLaunchConfig: vi.fn().mockResolvedValue({
    projectId: 'proj_1',
    projectName: 'test-project',
    variant: 'cluster-base',
    cloudUrl: 'http://localhost:3000',
    clusterId: 'cluster_1',
    imageTag: 'ghcr.io/generacy-ai/cluster-base:latest',
    orgId: 'org_1',
    repos: { primary: 'owner/repo' },
  }),
}));

vi.mock('../compose.js', () => ({
  pullImage: vi.fn(),
  startCluster: vi.fn(),
  streamLogsUntilActivation: vi.fn().mockResolvedValue({
    verificationUri: 'https://example.com/verify',
    userCode: 'ABCD-1234',
  }),
}));

vi.mock('../browser.js', () => ({
  openBrowser: vi.fn(),
}));

vi.mock('../registry.js', () => ({
  registerCluster: vi.fn(),
}));

vi.mock('../../../../utils/cloud-url.js', () => ({
  resolveApiUrl: vi.fn((url?: string) => url ?? 'https://api.generacy.ai'),
}));

vi.mock('../../cluster/scaffolder.js', () => ({
  sanitizeComposeProjectName: vi.fn((name: string, _id: string) => name.toLowerCase()),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('launchAction → clearStaleActivation integration', () => {
  let tempDir: string;
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'launch-vol-test-'));
    // Prevent process.exit from terminating vitest
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls clearStaleActivation when --claim is provided', async () => {
    const { launchCommand } = await import('../index.js');

    const cmd = launchCommand();
    await cmd.parseAsync(['node', 'launch', '--claim', 'test-claim-123', '--dir', tempDir]);

    expect(mockClearStaleActivation).toHaveBeenCalledTimes(1);
    expect(mockClearStaleActivation).toHaveBeenCalledWith('test-project');
  });

  it('does NOT call clearStaleActivation when --claim is absent', async () => {
    const { launchCommand } = await import('../index.js');

    const cmd = launchCommand();
    await cmd.parseAsync(['node', 'launch', '--dir', tempDir]);

    expect(mockClearStaleActivation).not.toHaveBeenCalled();
  });
});
