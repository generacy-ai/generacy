import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ── Mock heavy dependencies before imports ───────────────────────

vi.mock('../../utils/logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { getLogger: vi.fn(() => logger) };
});

vi.mock('../../../orchestrator/index.js', () => ({
  createOrchestratorServer: vi.fn(() => ({
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getPort: vi.fn(() => 3100),
  })),
}));

vi.mock('../../../orchestrator/redis-job-queue.js', () => ({
  createJobQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../orchestrator/label-monitor-bridge.js', () => ({
  LabelMonitorBridge: vi.fn(function () { return {}; }),
}));

// Mock orchestrator services (dynamically imported in setupLabelMonitor)
// Use regular functions (not arrows) so they work as constructors with `new`
vi.mock('@generacy-ai/orchestrator', () => ({
  LabelMonitorService: vi.fn(function () {
    return {
      startPolling: vi.fn().mockResolvedValue(undefined),
      stopPolling: vi.fn(),
    };
  }),
  LabelSyncService: vi.fn(function () {
    return {
      syncAll: vi.fn().mockResolvedValue({
        successfulRepos: 0,
        failedRepos: 0,
        totalRepos: 0,
      }),
    };
  }),
  SmeeWebhookReceiver: vi.fn(function () { return {}; }),
  PhaseTrackerService: vi.fn(function () { return {}; }),
  WebhookSetupService: vi.fn(function () { return {}; }),
  resolveClusterIdentity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(),
}));

vi.mock('@generacy-ai/config', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/config')>('@generacy-ai/config');
  return {
    ...actual,
    findWorkspaceConfigPath: vi.fn(() => null),
    tryLoadWorkspaceConfig: vi.fn(() => null),
    getMonitoredRepos: vi.fn(() => []),
    detectRepoDrift: vi.fn(() => null),
  };
});

// ── Imports (after vi.mock hoisting) ─────────────────────────────

import { getLogger } from '../../utils/logger.js';
import { LabelMonitorService } from '@generacy-ai/orchestrator';
import {
  findWorkspaceConfigPath,
  tryLoadWorkspaceConfig,
  getMonitoredRepos,
  detectRepoDrift,
} from '@generacy-ai/config';
import { orchestratorCommand } from '../orchestrator.js';

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract the `repositories` argument (6th positional) passed to
 * the LabelMonitorService constructor.
 */
function getServiceRepos(): { owner: string; repo: string }[] | undefined {
  const calls = (LabelMonitorService as unknown as Mock).mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1][5];
}

const ENV_KEYS = [
  'MONITORED_REPOS',
  'LABEL_MONITOR_ENABLED',
  'REDIS_URL',
  'ORCHESTRATOR_TOKEN',
  'SMEE_CHANNEL_URL',
  'POLL_INTERVAL_MS',
  'CLUSTER_GITHUB_USERNAME',
] as const;

// ── Tests ────────────────────────────────────────────────────────

describe('orchestrator monitored repos resolution', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.clearAllMocks();

    // Default mocks
    (findWorkspaceConfigPath as unknown as Mock).mockReturnValue(null);
    (tryLoadWorkspaceConfig as unknown as Mock).mockReturnValue(null);
    (getMonitoredRepos as unknown as Mock).mockReturnValue([]);
    (detectRepoDrift as unknown as Mock).mockReturnValue(null);

    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mockExit.mockRestore();
  });

  async function runCommand(args: string[] = []) {
    const command = orchestratorCommand();
    await command.parseAsync(args, { from: 'user' });
  }

  // ── Priority: env var > config ────────────────────────────────

  it('MONITORED_REPOS env var takes priority over config file', async () => {
    process.env['MONITORED_REPOS'] = 'generacy-ai/generacy,generacy-ai/contracts';

    // Config file has different repos
    (findWorkspaceConfigPath as unknown as Mock).mockReturnValue('/mock/.generacy/config.yaml');
    (tryLoadWorkspaceConfig as unknown as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'tetrad-development', monitor: true },
        { name: 'other-repo', monitor: true },
      ],
    });
    (getMonitoredRepos as unknown as Mock).mockReturnValue([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'other-repo' },
    ]);
    (detectRepoDrift as unknown as Mock).mockReturnValue(null);

    await runCommand(['--label-monitor']);

    // LabelMonitorService should receive env-var repos, not config repos
    const repos = getServiceRepos();
    expect(repos).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  // ── Fallback: config file when no env var ─────────────────────

  it('config file is used as fallback when MONITORED_REPOS is empty', async () => {
    const configRepos = [
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'tetrad-development' },
    ];

    (findWorkspaceConfigPath as unknown as Mock).mockReturnValue('/mock/.generacy/config.yaml');
    (tryLoadWorkspaceConfig as unknown as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'generacy', monitor: true },
        { name: 'tetrad-development', monitor: true },
        { name: 'tools', monitor: false },
      ],
    });
    (getMonitoredRepos as unknown as Mock).mockReturnValue(configRepos);

    await runCommand(['--label-monitor']);

    const repos = getServiceRepos();
    expect(repos).toEqual(configRepos);
    expect(repos).toHaveLength(2);
  });

  // ── Drift detection ───────────────────────────────────────────

  it('drift detection logs warning when env and config repos differ', async () => {
    process.env['MONITORED_REPOS'] = 'generacy-ai/generacy';

    (findWorkspaceConfigPath as unknown as Mock).mockReturnValue('/mock/.generacy/config.yaml');
    (tryLoadWorkspaceConfig as unknown as Mock).mockReturnValue({
      org: 'generacy-ai',
      branch: 'develop',
      repos: [
        { name: 'generacy', monitor: true },
        { name: 'contracts', monitor: true },
      ],
    });
    (getMonitoredRepos as unknown as Mock).mockReturnValue([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
    (detectRepoDrift as unknown as Mock).mockReturnValue({
      inConfigOnly: ['generacy-ai/contracts'],
      inEnvOnly: [],
    });

    await runCommand(['--label-monitor']);

    // detectRepoDrift should have been called with config repos and env repos
    expect(detectRepoDrift).toHaveBeenCalledWith(
      [
        { owner: 'generacy-ai', repo: 'generacy' },
        { owner: 'generacy-ai', repo: 'contracts' },
      ],
      [{ owner: 'generacy-ai', repo: 'generacy' }],
    );

    // Logger should have warned about drift
    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        inConfigOnly: ['generacy-ai/contracts'],
        inEnvOnly: [],
      }),
      expect.stringContaining('drift'),
    );
  });

  // ── Error: no repos from any source ───────────────────────────

  it('exits with error when no repos resolved from any source', async () => {
    // No MONITORED_REPOS env var, no config file
    (findWorkspaceConfigPath as unknown as Mock).mockReturnValue(null);

    await runCommand(['--label-monitor']);

    expect(mockExit).toHaveBeenCalledWith(1);

    const logger = getLogger();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no valid repositories'),
    );
  });
});
