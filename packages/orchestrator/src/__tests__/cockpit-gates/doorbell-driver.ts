/**
 * Doorbell driver for the cockpit gates integration harness (#1024).
 *
 * Spawns `packages/generacy/dist/bin/generacy.js cockpit doorbell` as a real
 * child process (per plan clarification Q3 → C: only a real spawn/kill
 * exercises FR-007's restart-replay assertion). Line-buffered stdout is
 * pushed both raw (into `stdoutLines`) and JSON-parsed (into `events`).
 *
 * Relies on the built `dist/bin/generacy.js` — the harness invocation
 * (`quickstart.md`) documents `pnpm --filter @generacy-ai/generacy build`
 * as a prerequisite. `tsx`-fallback was rejected in research.md §R-3 to
 * keep the runtime dep graph small.
 *
 * See `specs/1024-part-cockpit-remote-gates/data-model.md` §"DoorbellDriver".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export interface DoorbellDriverOptions {
  /** Absolute path to the answers-file the doorbell should tail. */
  answersFilePath: string;
  /** Additional env vars for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Extra CLI flags for `generacy cockpit doorbell` (e.g. an epic ref). */
  extraArgs?: string[];
  /** Node binary; default process.execPath. */
  nodeBin?: string;
  /** Path to the built generacy bin; default `<repo-root>/packages/generacy/dist/bin/generacy.js`. */
  generacyBin?: string;
}

export interface DoorbellEvent {
  type: string;
  [k: string]: unknown;
}

export interface DoorbellDriver {
  /** Every stdout line the child has written, in order. Includes non-JSON. */
  readonly stdoutLines: string[];

  /** Parsed events (JSON.parse) surfaced by the doorbell. */
  readonly events: DoorbellEvent[];

  /** Wait until the doorbell has emitted an event matching the predicate. */
  waitForEvent(
    match: (event: DoorbellEvent) => boolean,
    timeoutMs?: number,
  ): Promise<DoorbellEvent>;

  /** SIGTERM the child; wait for exit (SIGKILL fallback on timeout). */
  stop(timeoutMs?: number): Promise<void>;

  /** Start the child. Throws if it exits before yielding its first line. */
  start(): Promise<void>;

  /** stop + start reusing the same env (FR-007 restart scenario).
   *  Does NOT reset `stdoutLines`/`events` — the caller distinguishes
   *  pre-restart from post-restart by capturing offsets before the call. */
  restart(timeoutMs?: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 20;
const DEFAULT_STOP_TIMEOUT_MS = 3000;

function repoRoot(): string {
  // packages/orchestrator/src/__tests__/cockpit-gates/ → up 5 to repo root.
  return path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..');
}

async function waitForPredicate<T>(
  predicate: () => T | null | undefined,
  timeoutMs: number,
  onTimeout: () => string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = predicate();
    if (result != null) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(onTimeout());
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export function createDoorbellDriver(opts: DoorbellDriverOptions): DoorbellDriver {
  const nodeBin = opts.nodeBin ?? process.execPath;
  const generacyBin =
    opts.generacyBin ?? path.join(repoRoot(), 'packages/generacy/dist/bin/generacy.js');

  const stdoutLines: string[] = [];
  const events: DoorbellEvent[] = [];

  let child: ChildProcess | null = null;
  let stdoutReader: ReadlineInterface | null = null;
  let stderrChunks: string[] = [];
  let exitPromise: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    if (child != null) return;
    stderrChunks = [];
    const env = { ...process.env, ...(opts.env ?? {}) };
    // Ensure the child sees the answers-file path even if the caller didn't
    // set it in `env` — belt and braces.
    env.COCKPIT_ANSWERS_FILE = opts.answersFilePath;

    child = spawn(
      nodeBin,
      [generacyBin, 'cockpit', 'doorbell', ...(opts.extraArgs ?? [])],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
    });

    child.stdout?.setEncoding('utf8');
    stdoutReader = createInterface({ input: child.stdout! });
    stdoutReader.on('line', (line) => {
      stdoutLines.push(line);
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      if (trimmed[0] !== '{') return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          parsed != null &&
          typeof parsed === 'object' &&
          'type' in (parsed as Record<string, unknown>) &&
          typeof (parsed as Record<string, unknown>).type === 'string'
        ) {
          events.push(parsed as DoorbellEvent);
        }
      } catch {
        /* not JSON; already recorded in stdoutLines */
      }
    });

    const currentChild = child;
    exitPromise = new Promise<void>((resolve) => {
      currentChild.once('exit', () => resolve());
    });

    // Smoke test: if the child exits before yielding its first stdout line,
    // something is wrong with the spawn (missing bin, wrong Node version,
    // etc.). Surface a helpful error including captured stderr.
    const linesBefore = stdoutLines.length;
    const raced = await Promise.race([
      exitPromise.then(() => 'exit' as const),
      waitForPredicate<'ready' | null>(
        () => (stdoutLines.length > linesBefore ? 'ready' : null),
        DEFAULT_TIMEOUT_MS,
        () => `[doorbell-driver] start() timed out waiting for first stdout line after ${DEFAULT_TIMEOUT_MS}ms`,
      ).then(() => 'ready' as const),
    ]);
    if (raced === 'exit') {
      const code = currentChild.exitCode;
      const signal = currentChild.signalCode;
      const stderr = stderrChunks.join('') || '(empty)';
      const stdout = stdoutLines.join('\n') || '(empty)';
      throw new Error(
        `[doorbell-driver] child exited before yielding first stdout line ` +
          `(code=${code}, signal=${signal}).\nStderr:\n${stderr}\nStdout:\n${stdout}`,
      );
    }
  };

  const stop = async (timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> => {
    if (child == null) return;
    const currentChild = child;
    currentChild.kill('SIGTERM');
    const raced = await Promise.race([
      exitPromise ?? once(currentChild, 'exit').then(() => undefined),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), timeoutMs),
      ),
    ]);
    if (raced === 'timeout') {
      currentChild.kill('SIGKILL');
      await (exitPromise ?? once(currentChild, 'exit'));
    }
    stdoutReader?.close();
    stdoutReader = null;
    child = null;
    exitPromise = null;
  };

  const restart = async (timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> => {
    await stop(timeoutMs);
    await start();
  };

  return {
    stdoutLines,
    events,
    async waitForEvent(match, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return waitForPredicate<DoorbellEvent>(
        () => events.find((e) => match(e)) ?? null,
        timeoutMs,
        () => {
          const seenTypes = events.map((e) => e.type).join(', ') || '(none)';
          const recentStdout = stdoutLines.slice(-10).join('\n') || '(empty)';
          return `[doorbell-driver] waitForEvent timed out after ${timeoutMs}ms. Event types seen: [${seenTypes}]. Recent stdout:\n${recentStdout}`;
        },
      );
    },
    stop,
    start,
    restart,
  };
}
