/**
 * Subprocess regression test for #836.
 *
 * Spawns the compiled `generacy` CLI as a real child process, awaits the
 * startup line, sleeps ~5 s, then asserts the child is still running before
 * SIGTERMing it and asserting a clean exit 0.
 *
 * This test MUST run in a subprocess. Per clarifications.md Q1, an in-process
 * (`runWatch` + `onTick`) variant is structurally unable to catch the
 * unref'd-sleep drain bug because vitest's own runner handles keep the parent
 * event loop alive.
 *
 * Fixture: `generacy-ai/latency#31` is a stable, CLOSED, epic-shaped public
 * issue (has a `### Execution` heading with a ref-shaped task-list child).
 * Override via `WATCH_SUBPROCESS_FIXTURE_REF` if a different fixture is
 * preferred in CI.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// bin/generacy.js is the real CLI entry — it dynamically imports dist/cli/index.js.
const CLI_PATH = resolve(HERE, '../../../../../bin/generacy.js');
const FIXTURE_REF = process.env['WATCH_SUBPROCESS_FIXTURE_REF'] ?? 'generacy-ai/latency#31';
const SKIP = process.env['CI'] == null && process.env['GH_TOKEN'] == null;

const STARTUP_LINE_TIMEOUT_MS = 15_000;
const ALIVE_CHECK_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const INTERVAL_FLOOR_MS = 15_000;

describe.skipIf(SKIP)('cockpit watch subprocess regression (#836)', () => {
  it('survives past the first sleep and exits 0 on SIGTERM', async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `Compiled CLI not found at ${CLI_PATH}. Run \`pnpm --filter @generacy-ai/generacy build\` first.`,
      );
    }

    const child = spawn(
      process.execPath,
      [CLI_PATH, 'cockpit', 'watch', FIXTURE_REF, '--interval', String(INTERVAL_FLOOR_MS)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderrBuf = '';
    let resolveStartup!: () => void;
    let rejectStartup!: (err: Error) => void;
    const startupSeen = new Promise<void>((res, rej) => {
      resolveStartup = res;
      rejectStartup = rej;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      if (stderrBuf.includes('cockpit watch: epic ')) {
        resolveStartup();
      }
    });

    const startupTimer = setTimeout(() => {
      rejectStartup(
        new Error(
          `Startup line not seen within ${STARTUP_LINE_TIMEOUT_MS}ms. stderr so far:\n${stderrBuf}`,
        ),
      );
    }, STARTUP_LINE_TIMEOUT_MS);

    try {
      await startupSeen;
    } finally {
      clearTimeout(startupTimer);
    }

    await new Promise<void>((r) => setTimeout(r, ALIVE_CHECK_MS));

    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    const closed = new Promise<number | null>((res, rej) => {
      const closeTimer = setTimeout(() => {
        rej(new Error(`Child did not close within ${CLOSE_TIMEOUT_MS}ms after SIGTERM`));
      }, CLOSE_TIMEOUT_MS);
      child.once('close', (code) => {
        clearTimeout(closeTimer);
        res(code);
      });
    });

    child.kill('SIGTERM');
    const exitCode = await closed;
    expect(exitCode).toBe(0);
  }, 60_000);
});
