import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import { AgentLauncher } from '../agent-launcher.js';
import type { CredhelperClient } from '../credhelper-client.js';
import type { AgentLaunchPlugin, LaunchIntent } from '../types.js';
import type { ProcessFactory } from '../../worker/types.js';

/**
 * Golden subscription-baseline test (FR-004/FR-005, SC-002).
 *
 * Proves the P1 route plumbing leaves subscription launches byte-for-byte
 * unchanged. The whole launch path is exercised end-to-end — real
 * `ClaudeCodeLaunchPlugin`, real credentials interceptor (via
 * `AgentLauncher`), only the credhelper daemon is doubled — and the final
 * `{ command, args, env }` triple per spawn kind is serialized with a
 * sorted-key `stableStringify` and compared byte-for-byte against the
 * checked-in fixture captured from the pre-P1 merge-base.
 *
 * Regeneration: `GOLDEN_UPDATE=1 pnpm exec vitest run golden`. A fixture-only
 * diff with no launch-path change is a red flag — see
 * `specs/1201-context-integration-issue/contracts/golden-fixture.md`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, 'fixtures', 'subscription-baseline.json');

/** Recursively sort object keys; arrays keep their order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

interface SpawnTriple {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Stub credhelper client: fixed session dir + fixed session env. The *real*
 * credentials interceptor (`applyCredentials`) runs against this — only the
 * credhelper daemon is doubled, so the wrapping + session-env merge are
 * exercised deterministically.
 */
class StubCredhelperClient implements CredhelperClient {
  beginSession = vi.fn(async (_role: string, _sessionId: string) => ({
    sessionDir: '/fixed/session',
    expiresAt: new Date(0),
  }));

  endSession = vi.fn(async (_sessionId: string) => {});
}

function createSpyFactory(): ProcessFactory {
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
const CWD = '/fixed/checkout';

/**
 * Fixed intent literals per kind (D-2). No `model` field anywhere → every
 * intent resolves to the subscription route, so no `CLAUDE_CONFIG_DIR` is
 * injected. `invoke` is deliberately excluded (spec enumerates six kinds).
 */
const INTENTS: Record<string, LaunchIntent> = {
  phase: {
    kind: 'phase',
    phase: 'plan',
    prompt: 'https://example.com/issues/1',
  },
  'pr-feedback': {
    kind: 'pr-feedback',
    prNumber: 42,
    prompt: 'address the review feedback',
  },
  'merge-conflict': {
    kind: 'merge-conflict',
    issueNumber: 7,
    prompt: 'resolve the conflicts',
  },
  review: {
    kind: 'review',
    issueNumber: 7,
    prompt: 'review charter body',
  },
  remediate: {
    kind: 'remediate',
    issueNumber: 7,
    prompt: 'remediation charter body',
  },
  'conversation-turn': {
    kind: 'conversation-turn',
    message: 'hello agent',
    skipPermissions: true,
  },
};

describe('golden subscription-baseline spawns (US2 / FR-004..005, SC-002)', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let defaultFactory: ProcessFactory;
  let interactiveFactory: ProcessFactory;
  let launcher: AgentLauncher;

  beforeEach(() => {
    // Wholesale replacement of the base env layer of the 3-layer merge — the
    // only way to pin the deterministic bytes (no injectable seam exists).
    savedEnv = process.env;
    process.env = { PATH: '/usr/bin', HOME: '/home/fixed' };

    defaultFactory = createSpyFactory();
    interactiveFactory = createSpyFactory();
    launcher = new AgentLauncher(
      new Map([
        ['default', defaultFactory],
        ['interactive', interactiveFactory],
      ]),
      new StubCredhelperClient(),
    );
    // No gatewayConfigDir: subscription launches never provision, and gateway
    // launches are covered by route-launch-env.test.ts.
    launcher.registerPlugin(new ClaudeCodeLaunchPlugin() as unknown as AgentLaunchPlugin);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  async function captureSpawn(kind: string): Promise<SpawnTriple> {
    const intent = INTENTS[kind];
    await launcher.launch({ intent, cwd: CWD, credentials: CREDENTIALS });

    // conversation-turn uses the 'interactive' stdio profile; the rest use
    // 'default'. Exactly one of the two factories was invoked.
    const factory =
      kind === 'conversation-turn' ? interactiveFactory : defaultFactory;
    const spawn = vi.mocked(factory.spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    return { command, args, env: options.env };
  }

  const KINDS = [
    'phase',
    'pr-feedback',
    'merge-conflict',
    'review',
    'remediate',
    'conversation-turn',
  ] as const;

  if (process.env.GOLDEN_UPDATE === '1') {
    it('captures the golden fixture (GOLDEN_UPDATE=1)', async () => {
      const spawns: Record<string, SpawnTriple> = {};
      for (const kind of KINDS) {
        spawns[kind] = await captureSpawn(kind);
        // Reset spy state between kinds so each capture sees exactly one call.
        vi.mocked(defaultFactory.spawn).mockClear();
        vi.mocked(interactiveFactory.spawn).mockClear();
      }

      const sourceSha =
        process.env.GOLDEN_SOURCE_SHA ?? '0000000000000000000000000000000000000000';
      const fixture = {
        capturedAt: new Date().toISOString(),
        sourceSha,
        spawns: sortKeys(spawns),
      };
      writeFileSync(FIXTURE_PATH, `${stableStringify(fixture)}\n`);
      expect(spawns).toBeDefined();
    });
  } else {
    it.each(KINDS)('spawn triple for %s matches the golden fixture', async (kind) => {
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
        spawns: Record<string, SpawnTriple>;
      };
      const actual = await captureSpawn(kind);
      expect(stableStringify(actual)).toBe(stableStringify(fixture.spawns[kind]));
    });

    it('no fixture env carries CLAUDE_CONFIG_DIR (subscription baseline invariant)', () => {
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
        spawns: Record<string, SpawnTriple>;
      };
      for (const triple of Object.values(fixture.spawns)) {
        expect(triple.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      }
    });

    it('the fixture enumerates exactly the six expected kinds', () => {
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
        spawns: Record<string, SpawnTriple>;
      };
      expect(Object.keys(fixture.spawns).sort()).toEqual([...KINDS].sort());
    });
  }
});
