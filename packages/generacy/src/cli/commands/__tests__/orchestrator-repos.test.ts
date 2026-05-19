import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock heavy dependencies before imports ───────────────────────

const mockConfig = {
  server: { port: 3100, host: '0.0.0.0' },
  logging: { level: 'info', pretty: false },
  dispatch: { heartbeatTtlMs: 60000, shutdownTimeoutMs: 30000 },
  redis: { url: '' },
  monitor: { pollIntervalMs: 30000 },
  repositories: [] as { owner: string; repo: string }[],
  auth: { enabled: false, providers: [], jwt: { secret: 'test', expiresIn: '1h' } },
  rateLimit: { enabled: false },
  cors: { origin: true, credentials: true },
};

const mockServer = {
  log: { info: vi.fn() },
};

vi.mock('@generacy-ai/orchestrator', () => ({
  loadConfig: vi.fn(() => ({ ...mockConfig, repositories: [...mockConfig.repositories] })),
  createServer: vi.fn(async () => mockServer),
  startServer: vi.fn(async () => 'http://0.0.0.0:3100'),
  InMemoryApiKeyStore: vi.fn(function () {
    return { addKey: vi.fn() };
  }),
}));

// ── Imports (after vi.mock hoisting) ─────────────────────────────

import { loadConfig, createServer } from '@generacy-ai/orchestrator';
import { orchestratorCommand } from '../orchestrator.js';

// ── Tests ────────────────────────────────────────────────────────

const ENV_KEYS = [
  'MONITORED_REPOS',
  'LABEL_MONITOR_ENABLED',
  'ORCHESTRATOR_TOKEN',
  'ORCHESTRATOR_JWT_SECRET',
] as const;

describe('orchestrator CLI repos resolution', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // loadConfig needs JWT secret to be set
    process.env['ORCHESTRATOR_JWT_SECRET'] = 'test-secret-at-least-32-characters-long';
    vi.clearAllMocks();
    // Reset mock config repos
    mockConfig.repositories = [];
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

  it('CLI --monitored-repos overrides loadConfig repositories', async () => {
    // loadConfig returns some repos
    mockConfig.repositories = [
      { owner: 'generacy-ai', repo: 'tetrad-development' },
    ];

    await runCommand(['--monitored-repos', 'generacy-ai/generacy,generacy-ai/contracts']);

    // createServer should receive CLI repos, not loadConfig repos
    const callArgs = vi.mocked(createServer).mock.calls[0]![0];
    expect(callArgs.config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  it('uses loadConfig repositories when no CLI --monitored-repos', async () => {
    mockConfig.repositories = [
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'tetrad-development' },
    ];

    await runCommand([]);

    const callArgs = vi.mocked(createServer).mock.calls[0]![0];
    expect(callArgs.config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'tetrad-development' },
    ]);
  });

  it('warns and disables label monitor when enabled but no repos', async () => {
    mockConfig.repositories = [];

    await runCommand(['--label-monitor']);

    // Should NOT exit — server handles labelMonitor + empty repos gracefully.
    expect(mockExit).not.toHaveBeenCalled();

    // Label monitor should be disabled in the resulting config passed to the server.
    const callArgs = vi.mocked(createServer).mock.calls[0]![0];
    expect(callArgs.config.labelMonitor).toBe(false);
  });

  it('delegates config file fallback to loadConfig', async () => {
    await runCommand([]);

    // loadConfig is called once — the orchestrator package handles env/config file resolution
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });
});
