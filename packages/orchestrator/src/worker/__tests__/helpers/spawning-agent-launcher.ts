/**
 * Spawning `AgentLauncher` test double (#1168, Q1→A).
 *
 * A lightweight double injected as `ReviewExecutor`'s `agentLauncher`. Its
 * `launch()` REALLY spawns the scripted CLI fixture (`fixtures/scripted-review-cli.mjs`)
 * and returns a real `ChildProcessHandle`, keeping the executor and verdict
 * recomputation fully real (SC-002). It is NOT a verdict-steering stub — it only
 * spawns and adapts; all verdict authority stays in `ReviewExecutor` + `computeVerdict`.
 *
 * Scoped to the write / withhold (missing-sidecar) scenarios only (Q2→A). The
 * timeout and non-zero-exit paths inject a mocked hanging `ChildProcessHandle`
 * instead (see `phase-loop.remediate-timeout.integration.test.ts`).
 *
 * `AgentLauncher` is a concrete class with private members, so this double cannot
 * structurally implement it — inject it via `as unknown as AgentLauncher`.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentLauncher } from '../../../launcher/agent-launcher.js';
import type { LaunchHandle, LaunchRequest, OutputParser } from '../../../launcher/types.js';
import type { ChildProcessHandle } from '../../types.js';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'scripted-review-cli.mjs',
);

/** Per-scenario env closed over at construction and forwarded verbatim to the spawn. */
export interface SpawningLauncherEnv {
  FIXTURE_CHECKOUT_PATH: string;
  FIXTURE_WORKFLOW_ID: string;
  FIXTURE_MODE: 'write' | 'withhold';
  FIXTURE_CANDIDATE_JSON?: string;
}

const noopParser: OutputParser = {
  processChunk() {},
  flush() {},
};

/**
 * Build a spawning `AgentLauncher` double. Cast the result
 * `as unknown as AgentLauncher` at the injection site.
 */
export function createSpawningAgentLauncher(env: SpawningLauncherEnv): {
  launch(request: LaunchRequest): Promise<LaunchHandle>;
} {
  return {
    async launch(request: LaunchRequest): Promise<LaunchHandle> {
      const child = spawn(process.execPath, [FIXTURE_PATH], {
        cwd: request.cwd,
        env: {
          ...process.env,
          FIXTURE_CHECKOUT_PATH: env.FIXTURE_CHECKOUT_PATH,
          FIXTURE_WORKFLOW_ID: env.FIXTURE_WORKFLOW_ID,
          FIXTURE_MODE: env.FIXTURE_MODE,
          ...(env.FIXTURE_CANDIDATE_JSON !== undefined
            ? { FIXTURE_CANDIDATE_JSON: env.FIXTURE_CANDIDATE_JSON }
            : {}),
        },
      });

      const processHandle: ChildProcessHandle = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        pid: child.pid,
        kill: (signal?: NodeJS.Signals) => child.kill(signal),
        exitPromise: new Promise<number | null>((resolve) => {
          child.on('exit', (code) => resolve(code));
        }),
      };

      return {
        process: processHandle,
        outputParser: noopParser,
        metadata: { pluginId: 'test-spawning-double', intentKind: 'review' },
      };
    },
  };
}

/** Convenience: the double already cast to the injection type. */
export function createSpawningAgentLauncherAsLauncher(env: SpawningLauncherEnv): AgentLauncher {
  return createSpawningAgentLauncher(env) as unknown as AgentLauncher;
}
