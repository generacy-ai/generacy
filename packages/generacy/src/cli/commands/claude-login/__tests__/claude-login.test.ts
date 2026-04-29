import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../utils/cluster-context.js', () => ({
  getClusterContext: vi.fn(),
}));

vi.mock('../../../utils/browser.js', () => ({
  openUrl: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { spawn } from 'node:child_process';
import { getClusterContext } from '../../../utils/cluster-context.js';
import { openUrl } from '../../../utils/browser.js';

const mockedSpawn = vi.mocked(spawn);
const mockedGetClusterContext = vi.mocked(getClusterContext);
const mockedOpenUrl = vi.mocked(openUrl);

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough };
  child.stdout = new PassThrough();
  return child;
}

describe('claudeLoginCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Prevent process.exit from killing the test runner
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('spawns docker compose exec and opens detected URL', async () => {
    mockedGetClusterContext.mockResolvedValue({
      clusterId: 'my-cluster',
      projectId: 'proj_abc',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      generacyDir: '/home/user/project/.generacy',
      projectDir: '/home/user/project',
    });

    const fakeChild = createFakeChild();
    mockedSpawn.mockReturnValue(fakeChild as any);

    // Import the command and execute it
    const { claudeLoginCommand } = await import('../index.js');
    const cmd = claudeLoginCommand();

    // Run the action (it will call process.exit at the end)
    const actionPromise = cmd.parseAsync(['node', 'generacy', 'claude-login']);

    // Simulate claude /login output with a URL
    await new Promise((r) => setTimeout(r, 10));
    fakeChild.stdout.write('Authenticating...\n');
    fakeChild.stdout.write('Open https://auth.anthropic.com/login?code=abc123 to sign in\n');
    fakeChild.stdout.end();

    // Simulate child process exit
    await new Promise((r) => setTimeout(r, 10));
    fakeChild.emit('close', 0);

    await actionPromise.catch(() => {}); // may throw due to process.exit mock

    // Verify docker compose was called correctly
    expect(mockedSpawn).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--project-name', 'my-cluster',
        '--project-directory', '/home/user/project',
        'exec', '-it', 'orchestrator',
        'claude', '/login',
      ],
      { stdio: ['inherit', 'pipe', 'inherit'] },
    );

    // Verify URL was detected and opened
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://auth.anthropic.com/login?code=abc123');

    // Verify exit with child's exit code
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('exits with non-zero when docker compose fails', async () => {
    mockedGetClusterContext.mockResolvedValue({
      clusterId: 'my-cluster',
      projectId: 'proj_abc',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      generacyDir: '/home/user/project/.generacy',
      projectDir: '/home/user/project',
    });

    const fakeChild = createFakeChild();
    mockedSpawn.mockReturnValue(fakeChild as any);

    const { claudeLoginCommand } = await import('../index.js');
    const cmd = claudeLoginCommand();

    const actionPromise = cmd.parseAsync(['node', 'generacy', 'claude-login']);

    await new Promise((r) => setTimeout(r, 10));
    fakeChild.stdout.end();
    fakeChild.emit('close', 1);

    await actionPromise.catch(() => {});

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
