import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeCodeLaunchPlugin,
  GatewayRouteUnavailableError,
  _resetGatewayProvisionCacheForTests,
} from '@generacy-ai/generacy-plugin-claude-code';
import { AgentLauncher } from '../agent-launcher.js';
import type { CredhelperClient } from '../credhelper-client.js';
import type { AgentLaunchPlugin, LaunchIntent } from '../types.js';
import type { ProcessFactory } from '../../worker/types.js';

/**
 * Stub credhelper client: fixed session dir, no-op end. The *real* credentials
 * interceptor (applyCredentials) runs against this — FR-001 requires the launch
 * path be exercised end-to-end, only the credhelper daemon is doubled.
 */
class StubCredhelperClient implements CredhelperClient {
  beginSession = vi.fn(async (_role: string, _sessionId: string) => ({
    sessionDir: '/fixed/session',
    expiresAt: new Date(0),
  }));

  endSession = vi.fn(async (_sessionId: string) => {});
}

function createMockFactory(): ProcessFactory {
  return {
    spawn: vi.fn<ProcessFactory['spawn']>().mockReturnValue({
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 1234,
      kill: vi.fn().mockReturnValue(true),
      exitPromise: Promise.resolve(0),
    }),
  };
}

const CREDENTIALS = { role: 'test-role', uid: 1000, gid: 1000 } as const;

function spawnedEnv(factory: ProcessFactory): Record<string, string> {
  const spawn = vi.mocked(factory.spawn);
  expect(spawn).toHaveBeenCalledTimes(1);
  const options = spawn.mock.calls[0][2];
  return options.env;
}

describe('route-dependent launch env (US1 / FR-001..003)', () => {
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    _resetGatewayProvisionCacheForTests();
    // A stray CLAUDE_CONFIG_DIR in the runner env would leak into every merge
    // and mask the subscription-route "key absent" assertion.
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }
  });

  describe('with a provisioned gateway config dir (T011)', () => {
    let gatewayConfigDir: string;
    let defaultFactory: ProcessFactory;
    let launcher: AgentLauncher;

    beforeEach(() => {
      gatewayConfigDir = mkdtempSync(join(tmpdir(), 'gateway-config-'));
      writeFileSync(join(gatewayConfigDir, 'settings.json'), '{}');

      defaultFactory = createMockFactory();
      launcher = new AgentLauncher(
        new Map([
          ['default', defaultFactory],
          ['interactive', createMockFactory()],
        ]),
        new StubCredhelperClient(),
      );
      launcher.registerPlugin(
        new ClaudeCodeLaunchPlugin({ gatewayConfigDir }) as unknown as AgentLaunchPlugin,
      );
    });

    afterEach(() => {
      rmSync(gatewayConfigDir, { recursive: true, force: true });
    });

    it('sets CLAUDE_CONFIG_DIR to the gateway dir for a provider-qualified model', async () => {
      await launcher.launch({
        intent: {
          kind: 'phase',
          phase: 'plan',
          prompt: 'https://example.com/issues/1',
          model: 'openai/gpt-4o',
        },
        cwd: '/fixed/checkout',
        credentials: CREDENTIALS,
      });

      expect(spawnedEnv(defaultFactory).CLAUDE_CONFIG_DIR).toBe(gatewayConfigDir);
    });

    it.each<{ label: string; model: string | undefined }>([
      { label: 'undefined model', model: undefined },
      { label: 'a full claude-* id', model: 'claude-opus-4-8' },
      { label: 'an alias', model: 'opus' },
    ])('does NOT set CLAUDE_CONFIG_DIR for a subscription model ($label)', async ({ model }) => {
      await launcher.launch({
        intent: {
          kind: 'phase',
          phase: 'plan',
          prompt: 'https://example.com/issues/1',
          ...(model !== undefined && { model }),
        },
        cwd: '/fixed/checkout',
        credentials: CREDENTIALS,
      });

      expect(spawnedEnv(defaultFactory)).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    });
  });

  describe('without a provisioned gateway config dir (T012)', () => {
    it('throws GatewayRouteUnavailableError and never spawns', async () => {
      const gatewayConfigDir = join(tmpdir(), 'gateway-does-not-exist-1201');
      const defaultFactory = createMockFactory();
      const launcher = new AgentLauncher(
        new Map([['default', defaultFactory]]),
        new StubCredhelperClient(),
      );
      launcher.registerPlugin(
        new ClaudeCodeLaunchPlugin({ gatewayConfigDir }) as unknown as AgentLaunchPlugin,
      );

      await expect(
        launcher.launch({
          intent: {
            kind: 'phase',
            phase: 'plan',
            prompt: 'https://example.com/issues/1',
            model: 'openai/gpt-4o',
          } satisfies LaunchIntent,
          cwd: '/fixed/checkout',
          credentials: CREDENTIALS,
        }),
      ).rejects.toBeInstanceOf(GatewayRouteUnavailableError);

      expect(defaultFactory.spawn).not.toHaveBeenCalled();
    });
  });

  describe('credentials wrapper preserves inherited env (T013 / FR-003)', () => {
    it('passes CLAUDE_CONFIG_DIR through the sh wrapper to the exec child', () => {
      const sessionDir = mkdtempSync(join(tmpdir(), 'session-'));
      writeFileSync(join(sessionDir, 'env'), 'export SESSION_ENV_SOURCED=yes\n');

      try {
        const result = spawnSync(
          'sh',
          ['-c', '. "$GENERACY_SESSION_DIR/env" && exec "$@"', '_', '/usr/bin/env'],
          {
            env: {
              PATH: '/usr/bin:/bin',
              GENERACY_SESSION_DIR: sessionDir,
              CLAUDE_CONFIG_DIR: '/sentinel/gateway-config',
            },
            encoding: 'utf8',
          },
        );

        expect(result.status).toBe(0);
        // Inherited parent env survives the wrapper untouched...
        expect(result.stdout).toContain('CLAUDE_CONFIG_DIR=/sentinel/gateway-config');
        // ...and the session env file is sourced before exec.
        expect(result.stdout).toContain('SESSION_ENV_SOURCED=yes');
      } finally {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    });
  });
});
