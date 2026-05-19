import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { ClaudeCliWorker } from '../../worker/claude-cli-worker.js';
import type { WorkerConfig } from '../../worker/config.js';
import { CredhelperUnavailableError } from '../../launcher/credhelper-errors.js';

// Mock existsSync to control socket presence
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

// Mock workflow-engine to avoid filesystem/process dependencies
vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(),
  createFeature: vi.fn(),
  registerProcessLauncher: vi.fn(),
  clearProcessLauncher: vi.fn(),
}));

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp/test-workspaces',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test',
    preValidateCommand: 'pnpm install',
    maxImplementRetries: 2,
    gates: {},
    ...overrides,
  };
}

describe('ClaudeCliWorker fail-fast startup check', () => {
  const mockedExistsSync = vi.mocked(existsSync);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockedExistsSync.mockReset();
  });

  it('should throw CredhelperUnavailableError when credentialRole is set but socket does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    const config = makeConfig({ credentialRole: 'developer' });

    expect(() => new ClaudeCliWorker(config, makeFakeLogger())).toThrow(CredhelperUnavailableError);
  });

  it('should succeed when credentialRole is undefined (legacy mode)', () => {
    // Socket doesn't exist but no role configured — should be fine
    mockedExistsSync.mockReturnValue(false);

    const config = makeConfig();

    expect(() => new ClaudeCliWorker(config, makeFakeLogger())).not.toThrow();
  });

  it('should succeed when credentialRole is set and socket exists', () => {
    mockedExistsSync.mockReturnValue(true);

    const config = makeConfig({ credentialRole: 'developer' });

    expect(() => new ClaudeCliWorker(config, makeFakeLogger())).not.toThrow();
  });
});
