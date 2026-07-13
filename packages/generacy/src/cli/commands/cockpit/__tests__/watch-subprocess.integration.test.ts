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
 *
 * This is a network/gh-bound integration test (it drives `cockpit watch`,
 * which fetches the epic from GitHub via `gh`). Per specs/871 it therefore
 * lives under the `*.integration.test.ts` convention — excluded from the
 * default unit suite and run only by the blocking `integration` CI job, which
 * provisions `GH_TOKEN` (analogous to how the orchestrator integration tests
 * are provisioned a Redis service). The skip guard keys off `GH_TOKEN` so the
 * outcome is deterministic: it runs wherever GitHub auth is present and cleanly
 * skips where it is not (e.g. a bare `pnpm test:integration` with no token),
 * rather than hard-failing when `CI` is set but no auth was provisioned.
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
const SKIP = process.env['GH_TOKEN'] == null;

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

describe.skipIf(SKIP)('cockpit watch --exit-on-epic-complete (#885)', () => {
  it('exits 0 after emitting epic-complete as the final stdout line', async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `Compiled CLI not found at ${CLI_PATH}. Run \`pnpm --filter @generacy-ai/generacy build\` first.`,
      );
    }

    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        'cockpit',
        'watch',
        FIXTURE_REF,
        '--interval',
        String(INTERVAL_FLOOR_MS),
        '--exit-on-epic-complete',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
    });

    const closed = new Promise<number | null>((res, rej) => {
      const closeTimer = setTimeout(() => {
        rej(new Error(`Child did not exit within 45s`));
      }, 45_000);
      child.once('close', (code) => {
        clearTimeout(closeTimer);
        res(code);
      });
    });

    const exitCode = await closed;
    expect(exitCode).toBe(0);

    const lines = stdoutBuf.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1]!;
    const lastParsed = JSON.parse(lastLine) as { type?: string };
    expect(lastParsed.type).toBe('epic-complete');

    // No `epic-complete` line may appear anywhere other than as the final line.
    for (let i = 0; i < lines.length - 1; i++) {
      const parsed = JSON.parse(lines[i]!) as { type?: string };
      expect(parsed.type).not.toBe('epic-complete');
    }
  }, 60_000);

  it('without --exit-on-epic-complete, keeps polling after epic-complete', async () => {
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

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (c: Buffer) => {
      stdoutBuf += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBuf += c.toString('utf-8');
    });

    let resolveStartup!: () => void;
    let rejectStartup!: (err: Error) => void;
    const startupSeen = new Promise<void>((res, rej) => {
      resolveStartup = res;
      rejectStartup = rej;
    });
    const stderrProbe = (): void => {
      if (stderrBuf.includes('cockpit watch: epic ')) resolveStartup();
    };
    child.stderr.on('data', stderrProbe);

    const startupTimer = setTimeout(() => {
      rejectStartup(
        new Error(`Startup line not seen within ${STARTUP_LINE_TIMEOUT_MS}ms`),
      );
    }, STARTUP_LINE_TIMEOUT_MS);
    try {
      await startupSeen;
    } finally {
      clearTimeout(startupTimer);
    }

    // Wait long enough for at least one poll cycle to complete and emit
    // epic-complete, but not so long it exits normally (never does without flag).
    await new Promise<void>((r) => setTimeout(r, 20_000));

    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    // stdout should contain the epic-complete NDJSON line already
    const lines = stdoutBuf.split('\n').filter((l) => l.length > 0);
    const hasEpicComplete = lines.some((l) => {
      try {
        const p = JSON.parse(l) as { type?: string };
        return p.type === 'epic-complete';
      } catch {
        return false;
      }
    });
    expect(hasEpicComplete).toBe(true);

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
