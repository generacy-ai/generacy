/**
 * Per-scenario wire-up for the cockpit gates integration harness (#1024).
 *
 * Composes: (1) a fresh temp dir with `COCKPIT_ANSWERS_FILE` pointing into
 * it, (2) a fake relay peer on a random port, (3) an in-process
 * orchestrator with its `RelayBridge` pointed at the peer, (4) a real
 * doorbell child process. Every scenario gets a fresh copy; `cleanup()` is
 * idempotent so `beforeEach`/`afterEach` can rely on the same handle.
 *
 * The orchestrator boot is currently a placeholder — the P1 siblings that
 * add the `POST /cockpit/gates` + `POST /cockpit/answers` routes (#1021),
 * the `cluster.cockpit` `ALLOWED_CHANNELS` entry (#1021), the retain-and-
 * replay branch (#1021), the answers-file writer (#1021), and the doorbell
 * answers-file tail (#1023) have not yet landed on `develop` as of this
 * harness's introduction. All Phase 3 scenarios are `.skip()`'d with
 * follow-up TODO comments naming the responsible sibling. When each
 * sibling lands, the unskip PR replaces `bootOrchestrator()` below with a
 * real `createServer()` call and imports the fixture builders from
 * `@generacy-ai/cockpit/gates`.
 *
 * See `specs/1024-part-cockpit-remote-gates/data-model.md` §"ScenarioContext".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startFakePeer, type FakePeer } from './fake-peer.js';
import {
  createDoorbellDriver,
  type DoorbellDriver,
} from './doorbell-driver.js';

export interface ScenarioContext {
  peer: FakePeer;
  doorbell: DoorbellDriver;
  /**
   * Orchestrator Fastify instance. `null` until #1021 lands the gate routes
   * — every Phase 3 scenario that would use it is currently `.skip()`'d.
   * When wiring the real boot, remove the `| null` and delete this comment.
   */
  orchestrator: FastifyInstance | null;
  answersFilePath: string;
  tempDir: string;
  /** `http://127.0.0.1:<port>` — `null` until orchestrator boot is wired. */
  orchestratorUrl: string | null;
  cleanup: () => Promise<void>;
}

export interface ScenarioSetupOptions {
  /** Skip spawning the doorbell (for scenarios that only exercise the up-path). */
  skipDoorbell?: boolean;
  /** Extra CLI args for the doorbell child. */
  doorbellArgs?: string[];
}

/**
 * Spin up a fresh scenario context. Call `cleanup()` in `afterEach`; safe
 * to call multiple times.
 */
export async function setupScenario(
  opts: ScenarioSetupOptions = {},
): Promise<ScenarioContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-gates-1024-'));
  const answersFilePath = path.join(tempDir, 'answers.ndjson');

  // Set COCKPIT_ANSWERS_FILE for the in-process orchestrator boot — the
  // writer sibling (#1021) reads it at construction. Must be set BEFORE
  // `createServer()` is called (once #1021 lands and the placeholder below
  // is replaced with a real boot).
  const previousAnswersFileEnv = process.env['COCKPIT_ANSWERS_FILE'];
  process.env['COCKPIT_ANSWERS_FILE'] = answersFilePath;

  const peer = await startFakePeer();

  // TODO(#1021): replace with real orchestrator boot once gate routes land:
  //   const orchestrator = await createServer({ config: {
  //     relay: { relayUrl: peer.url, apiKey: 'test-key', baseReconnectDelayMs: 50, ... },
  //     activation: { cloudUrl: undefined },
  //     ...
  //   } });
  //   await orchestrator.listen({ port: 0, host: '127.0.0.1' });
  //   const address = orchestrator.server.address();
  //   const orchestratorUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  //   await peer.waitForReconnect();
  const orchestrator: FastifyInstance | null = null;
  const orchestratorUrl: string | null = null;

  let doorbell: DoorbellDriver;
  if (opts.skipDoorbell === true) {
    // Callers that pass `skipDoorbell: true` never touch this field — but
    // returning a real (un-started) driver keeps the type non-nullable.
    doorbell = createDoorbellDriver({
      answersFilePath,
      env: { COCKPIT_ANSWERS_FILE: answersFilePath },
      extraArgs: opts.doorbellArgs ?? [],
    });
  } else {
    doorbell = createDoorbellDriver({
      answersFilePath,
      env: { COCKPIT_ANSWERS_FILE: answersFilePath },
      extraArgs: opts.doorbellArgs ?? [],
    });
    // TODO(#1023): uncomment once the doorbell tails an answers file:
    //   await doorbell.start();
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await doorbell.stop();
    } catch {
      /* best-effort */
    }
    if (orchestrator != null) {
      try {
        await (orchestrator as FastifyInstance).close();
      } catch {
        /* best-effort */
      }
    }
    try {
      await peer.close();
    } catch {
      /* best-effort */
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (previousAnswersFileEnv == null) {
      delete process.env['COCKPIT_ANSWERS_FILE'];
    } else {
      process.env['COCKPIT_ANSWERS_FILE'] = previousAnswersFileEnv;
    }
  };

  return {
    peer,
    doorbell,
    orchestrator,
    answersFilePath,
    tempDir,
    orchestratorUrl,
    cleanup,
  };
}

/**
 * Drain the in-process cockpit MCP event-bus registry from a given cursor.
 * Placeholder — depends on #1023 landing an in-process bus surface that
 * `cockpit_await_events` also consumes. See `contracts/env-seams.md` §S-7.
 *
 * TODO(#1023): implement once the in-process bus registry is reachable
 * from the harness (either via a direct import of the same accessor
 * `cockpit_await_events` uses, or via a test-only export from the doorbell
 * module).
 */
export async function awaitCockpitEvents(_sinceCursor: number): Promise<{
  entries: Array<{ event: { type: string; [k: string]: unknown } }>;
  cursor: number;
}> {
  throw new Error(
    '[scenario-helpers] awaitCockpitEvents() is not yet wired — depends on ' +
      '#1023 landing the doorbell answers-file tail and an in-process bus ' +
      'accessor. See specs/1024-part-cockpit-remote-gates/contracts/env-seams.md §S-7.',
  );
}
