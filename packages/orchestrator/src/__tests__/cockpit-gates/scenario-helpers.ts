/**
 * Per-scenario wire-up for the cockpit gates integration harness (#1024).
 *
 * Composes: (1) a fresh temp dir with `COCKPIT_ANSWERS_FILE` pointing into
 * it, (2) a fake relay peer on a random port, (3) an in-process
 * orchestrator (via `createTestServer` + `listen({ port: 0 })`), and
 * (optionally) (4) a doorbell child process driver. Every scenario gets a
 * fresh copy; `cleanup()` is idempotent so `beforeEach`/`afterEach` can
 * rely on the same handle.
 *
 * Current sibling state (2026-07-21): #1020 fixture builders + #1021
 * gate routes + `cluster.cockpit` `ALLOWED_CHANNELS` entry + retain-and-
 * replay + answers-file writer + #1023 doorbell answers-file tail have
 * NOT landed on `develop` (PRs #1025, #1027, #1028, #1029 are open). So
 * this file exercises what CAN be exercised today:
 *
 *   - The `createTestServer` + `server.listen({ port: 0 })` boot path
 *     (`orchestrator`, `orchestratorUrl` populated on every scenario).
 *   - The fake peer WS lifecycle (start/close/disconnect/reconnect,
 *     handshake handling, api_request/response correlation).
 *   - The doorbell driver's spawn/stop/restart mechanics via injectable
 *     `nodeBin` + `generacyBin` overrides (see `doorbell-driver.ts`).
 *
 * The scenarios in `cockpit-gates-integration.integration.test.ts` that
 * assert against the sibling routes (`POST /cockpit/gates`, `POST
 * /cockpit/answers`), the writer's file-level dedup, and the doorbell's
 * answers-file tail remain `.skip()` with `TODO(#<sibling>):` comments;
 * they unskip when their responsible sibling lands. The "Harness plumbing"
 * describe block in the same file DOES run today and provides real
 * regression signal against the harness scaffolding itself.
 *
 * See `specs/1024-part-cockpit-remote-gates/data-model.md` §"ScenarioContext".
 */
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createTestServer } from '../../server.js';
import { startFakePeer, type FakePeer } from './fake-peer.js';
import {
  createDoorbellDriver,
  type DoorbellDriver,
  type DoorbellDriverOptions,
} from './doorbell-driver.js';

export interface ScenarioContext {
  peer: FakePeer;
  doorbell: DoorbellDriver;
  /** Fastify instance booted via `createTestServer`. Listens on a random
   *  port (`orchestratorUrl` below). Uses `skipRoutes: true`, so it has NO
   *  gate routes registered — scenarios that assert against `POST
   *  /cockpit/gates` etc. must remain `.skip()` until sibling #1021 lands
   *  the real route. Tests are free to register their own routes on this
   *  instance via `orchestrator.post(...)` before assertions run. */
  orchestrator: FastifyInstance;
  answersFilePath: string;
  tempDir: string;
  /** `http://127.0.0.1:<port>` — always populated after `setupScenario`. */
  orchestratorUrl: string;
  cleanup: () => Promise<void>;
}

export interface ScenarioSetupOptions {
  /** Skip starting the doorbell child (default: true — the real doorbell
   *  answers-file tail lives in sibling #1023 which has not landed yet, so
   *  starting the current `generacy cockpit doorbell` binary would be
   *  meaningless. Individual harness self-tests that want to exercise the
   *  spawn/restart mechanics pass `skipDoorbell: false` with a
   *  `generacyBin` override pointing at a synthetic script). */
  skipDoorbell?: boolean;
  /** Extra CLI args for the doorbell child. */
  doorbellArgs?: string[];
  /** Override the doorbell driver options (e.g. `generacyBin` for a
   *  synthetic child script during harness plumbing self-tests). */
  doorbellDriverOptions?: Partial<DoorbellDriverOptions>;
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
  // writer sibling (#1021) reads it at construction, and the doorbell
  // sibling (#1023) reads it at spawn. Set BEFORE createTestServer so any
  // future writer that reads it at construction time sees the temp path.
  const previousAnswersFileEnv = process.env['COCKPIT_ANSWERS_FILE'];
  process.env['COCKPIT_ANSWERS_FILE'] = answersFilePath;

  const peer = await startFakePeer();

  // Boot the orchestrator on a random port. `createTestServer` uses
  // `skipRoutes: true`, so no gate routes are registered — scenarios that
  // hit them must either register their own inline routes on this
  // instance (harness self-tests do this) or remain `.skip()` until
  // sibling #1021 lands the real route.
  const orchestrator = await createTestServer();
  await orchestrator.listen({ port: 0, host: '127.0.0.1' });
  const address = orchestrator.server.address() as AddressInfo | string | null;
  if (address == null || typeof address === 'string') {
    throw new Error(
      `[scenario-helpers] unexpected server.address(): ${JSON.stringify(address)}`,
    );
  }
  const orchestratorUrl = `http://127.0.0.1:${address.port}`;

  const doorbellDriverOptions: DoorbellDriverOptions = {
    answersFilePath,
    env: { COCKPIT_ANSWERS_FILE: answersFilePath },
    extraArgs: opts.doorbellArgs ?? [],
    ...(opts.doorbellDriverOptions ?? {}),
  };
  const doorbell = createDoorbellDriver(doorbellDriverOptions);

  // The `generacy cockpit doorbell` binary currently ships as a smee/wake
  // sensor (issue-monitoring), NOT as an answers-file tail — the tail
  // behavior lives in unlanded sibling #1023. Auto-starting the current
  // binary would fail (it expects `--tracking` / `--new` / an issue ref
  // and connects to GitHub) and provide no useful signal for #1024.
  //
  // Individual scenarios that want to exercise `child spawn / SIGTERM /
  // restart` mechanics right now do so via `skipDoorbell: false` combined
  // with a synthetic `generacyBin` override — see the "Harness plumbing"
  // describe block in the sibling `.integration.test.ts`.
  //
  // When #1023 lands the real answers-file tail, flip the default to
  // `false` and delete this comment.
  const shouldStartDoorbell = opts.skipDoorbell === false;
  if (shouldStartDoorbell) {
    await doorbell.start();
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
    try {
      await orchestrator.close();
    } catch {
      /* best-effort */
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
 *
 * Returns an empty batch stub until sibling #1023 lands the doorbell
 * answers-file tail and an in-process bus surface that
 * `cockpit_await_events` also consumes. Callers can compose against this
 * shape today; when the bus surface lands, this function will start
 * returning real entries and the sibling-dependent scenarios in the
 * integration test file can unskip.
 *
 * The stub returns rather than throwing so scenario bodies that call it
 * during wire-up don't crash — the caller distinguishes "no events yet"
 * from "bus not wired" via the empty `entries` array vs. real data.
 *
 * TODO(#1023): return real entries from the in-process bus registry once
 * `cockpit_await_events` is reachable from the harness (either via a
 * direct import of the same accessor the MCP tool uses, or via a
 * test-only export from the doorbell module). See
 * `specs/1024-part-cockpit-remote-gates/contracts/env-seams.md` §S-7.
 */
export async function awaitCockpitEvents(_sinceCursor: number): Promise<{
  entries: Array<{ event: { type: string; [k: string]: unknown } }>;
  cursor: number;
}> {
  return { entries: [], cursor: _sinceCursor };
}
