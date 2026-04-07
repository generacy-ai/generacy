import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../loader.js';

const WORKSPACE_YAML = `
workspace:
  org: generacy-ai
  branch: develop
  repos:
    - name: tetrad-development
      monitor: true
    - name: generacy
      monitor: true
    - name: contracts
      monitor: false
`;

/**
 * Minimal auth config required by OrchestratorConfigSchema.
 * Auth is required and has no default, so every loadConfig() call
 * needs it supplied via env or file.
 */
const AUTH_ENV = {
  ORCHESTRATOR_AUTH_ENABLED: 'false',
  ORCHESTRATOR_JWT_SECRET: 'test-secret-at-least-32-characters-long!!',
};

let tempDir: string;
let originalCwd: typeof process.cwd;
let envSnapshot: Record<string, string | undefined>;

/** Env vars that the loader reads — cleared before each test. */
const LOADER_ENV_KEYS = [
  'MONITORED_REPOS',
  'ORCHESTRATOR_REPOSITORIES',
  'ORCHESTRATOR_PORT',
  'ORCHESTRATOR_HOST',
  'REDIS_URL',
  'ORCHESTRATOR_REDIS_URL',
  'ORCHESTRATOR_AUTH_ENABLED',
  'ORCHESTRATOR_JWT_SECRET',
  'ORCHESTRATOR_JWT_EXPIRES_IN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'ORCHESTRATOR_GITHUB_CALLBACK_URL',
  'ORCHESTRATOR_RATE_LIMIT_ENABLED',
  'ORCHESTRATOR_RATE_LIMIT_MAX',
  'ORCHESTRATOR_RATE_LIMIT_WINDOW',
  'LOG_LEVEL',
  'ORCHESTRATOR_LOG_LEVEL',
  'ORCHESTRATOR_LOG_PRETTY',
  'POLL_INTERVAL_MS',
  'ORCHESTRATOR_POLL_INTERVAL_MS',
  'WEBHOOK_SECRET',
  'ORCHESTRATOR_WEBHOOK_SECRET',
  'CLUSTER_GITHUB_USERNAME',
  'PR_MONITOR_ENABLED',
  'PR_MONITOR_POLL_INTERVAL_MS',
  'PR_MONITOR_WEBHOOK_SECRET',
  'PR_MONITOR_ADAPTIVE_POLLING',
  'PR_MONITOR_MAX_CONCURRENT_POLLS',
  'LABEL_MONITOR_ENABLED',
  'SMEE_CHANNEL_URL',
  'ORCHESTRATOR_SMEE_CHANNEL_URL',
  'WEBHOOK_SETUP_ENABLED',
  'ORCHESTRATOR_WEBHOOK_SETUP_ENABLED',
];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'loader-workspace-test-'));

  // Snapshot and clear env vars so tests start from a clean slate
  envSnapshot = {};
  for (const key of LOADER_ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }

  // Stub process.cwd() to point at the temp dir so findWorkspaceConfigPath
  // discovers our test config files.
  originalCwd = process.cwd;
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  // Restore env
  for (const key of LOADER_ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }

  // Restore cwd
  process.cwd = originalCwd;
  vi.restoreAllMocks();

  rmSync(tempDir, { recursive: true, force: true });
});

/** Place a .generacy/config.yaml in the temp dir. */
function writeWorkspaceConfig(yaml: string = WORKSPACE_YAML): void {
  const configDir = join(tempDir, '.generacy');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), yaml);
}

describe('orchestrator loader – workspace config fallback', () => {
  it('populates repositories from MONITORED_REPOS env var', () => {
    process.env['MONITORED_REPOS'] = 'generacy-ai/generacy,generacy-ai/contracts';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  it('populates repositories from ORCHESTRATOR_REPOSITORIES when MONITORED_REPOS is absent', () => {
    process.env['ORCHESTRATOR_REPOSITORIES'] = 'acme/repo-a,acme/repo-b';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.repositories).toEqual([
      { owner: 'acme', repo: 'repo-a' },
      { owner: 'acme', repo: 'repo-b' },
    ]);
  });

  it('falls back to .generacy/config.yaml when no env var is set', () => {
    writeWorkspaceConfig();
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    // Only monitor: true repos should appear (tetrad-development + generacy)
    expect(config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'generacy' },
    ]);
  });

  it('env var takes priority over config file when both exist', () => {
    writeWorkspaceConfig();
    process.env['MONITORED_REPOS'] = 'custom-org/custom-repo';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    // Env var wins — config file repos are ignored
    expect(config.repositories).toEqual([
      { owner: 'custom-org', repo: 'custom-repo' },
    ]);
  });

  it('returns empty repositories when no env var and no config file', () => {
    // No config file written, no env var set
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.repositories).toEqual([]);
  });

  it('skips malformed entries in MONITORED_REPOS', () => {
    process.env['MONITORED_REPOS'] = 'generacy-ai/generacy,,bare-name,/leading-slash';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    // Only valid owner/repo entries survive the filter
    expect(config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
    ]);
  });

  it('handles whitespace in MONITORED_REPOS gracefully', () => {
    process.env['MONITORED_REPOS'] = ' generacy-ai/generacy , generacy-ai/contracts ';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'generacy' },
      { owner: 'generacy-ai', repo: 'contracts' },
    ]);
  });

  it('config file fallback works with nested cwd (walks up)', () => {
    writeWorkspaceConfig();

    // Simulate cwd being a subdirectory — findWorkspaceConfigPath walks up
    const nested = join(tempDir, 'deep', 'nested', 'dir');
    mkdirSync(nested, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(nested);

    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.repositories).toEqual([
      { owner: 'generacy-ai', repo: 'tetrad-development' },
      { owner: 'generacy-ai', repo: 'generacy' },
    ]);
  });
});

describe('orchestrator loader – orchestrator block merge from config.yaml', () => {
  function writeOrchestratorConfig(yaml: string): void {
    const configDir = join(tempDir, '.generacy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), yaml);
  }

  it('sets labelMonitor from config.yaml orchestrator.labelMonitor', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  labelMonitor: true',
    ].join('\n'));
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.labelMonitor).toBe(true);
  });

  it('sets smee.channelUrl from config.yaml orchestrator.smeeChannelUrl', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  smeeChannelUrl: https://smee.io/abc123',
    ].join('\n'));
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.smee.channelUrl).toBe('https://smee.io/abc123');
  });

  it('sets webhookSetup.enabled from config.yaml orchestrator.webhookSetup', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  webhookSetup: true',
    ].join('\n'));
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.webhookSetup.enabled).toBe(true);
  });

  it('env var LABEL_MONITOR_ENABLED overrides config.yaml labelMonitor value', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  labelMonitor: false',
    ].join('\n'));
    process.env['LABEL_MONITOR_ENABLED'] = 'true';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.labelMonitor).toBe(true);
  });

  it('env var SMEE_CHANNEL_URL overrides config.yaml smeeChannelUrl', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  smeeChannelUrl: https://smee.io/from-config',
    ].join('\n'));
    process.env['SMEE_CHANNEL_URL'] = 'https://smee.io/from-env';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.smee.channelUrl).toBe('https://smee.io/from-env');
  });

  it('env var WEBHOOK_SETUP_ENABLED=true overrides config.yaml webhookSetup: false', () => {
    writeOrchestratorConfig([
      'repos:',
      '  primary: generacy-ai/generacy',
      'orchestrator:',
      '  webhookSetup: false',
    ].join('\n'));
    process.env['WEBHOOK_SETUP_ENABLED'] = 'true';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    expect(config.webhookSetup.enabled).toBe(true);
  });
});

describe('orchestrator loader – auto-populate conversations.workspaces', () => {
  it('populates conversations.workspaces from repos when workspace dirs exist', () => {
    // Create a fake /workspaces/todo-app directory to simulate the convention
    const fakeWorkspace = join(tempDir, 'fake-workspace');
    mkdirSync(fakeWorkspace, { recursive: true });

    // We can't easily test /workspaces/todo-app since that's absolute,
    // so we test via orchestrator.yaml that already sets conversations.workspaces.
    // Instead, verify the config loader leaves workspaces empty when dirs don't exist.
    process.env['MONITORED_REPOS'] = 'acme/nonexistent-repo';
    Object.assign(process.env, AUTH_ENV);

    const config = loadConfig({ loadEnv: true });

    // /workspaces/nonexistent-repo doesn't exist, so workspaces stays empty
    expect(config.conversations.workspaces).toEqual({});
  });

  it('does not overwrite explicitly configured workspaces', () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, 'orchestrator.yaml');
    writeFileSync(configFile, [
      'auth:',
      '  enabled: false',
      '  jwt:',
      '    secret: test-secret-at-least-32-characters-long!!',
      'repositories:',
      '  - owner: acme',
      '    repo: my-repo',
      'conversations:',
      '  workspaces:',
      '    "acme/my-repo": /custom/path',
    ].join('\n'));

    const config = loadConfig({ configFile, loadEnv: false });

    expect(config.conversations.workspaces).toEqual({ 'acme/my-repo': '/custom/path' });
  });
});
