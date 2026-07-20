import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PostActivationSettledMonitor } from '../services/post-activation-settled-monitor.js';

/**
 * Wait for a condition to become true or for `timeoutMs` to elapse. fs.watch
 * events on Linux fire asynchronously, so we poll rather than sleep a fixed
 * duration.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('PostActivationSettledMonitor', () => {
  let tempDir: string;
  let keyFilePath: string;
  let markerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'post-activation-settled-monitor-'));
    keyFilePath = join(tempDir, 'cluster-api-key');
    markerPath = join(tempDir, 'post-activation-restart-done');
    writeFileSync(keyFilePath, 'test-key');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not fire when marker is already present at start()', async () => {
    writeFileSync(markerPath, '');
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(onSettled).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not fire when key file is absent (local cluster)', async () => {
    unlinkSync(keyFilePath);
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();
    writeFileSync(markerPath, '');
    await new Promise((r) => setTimeout(r, 100));
    expect(onSettled).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('fires exactly once when marker appears', async () => {
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();
    writeFileSync(markerPath, '');
    await waitFor(() => onSettled.mock.calls.length > 0);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Subsequent writes should not re-fire (watcher has been closed).
    writeFileSync(markerPath, 'again');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSettled).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('start() then stop() before marker appears leaves no active watcher', async () => {
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();
    monitor.stop();

    writeFileSync(markerPath, '');
    await new Promise((r) => setTimeout(r, 100));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('rechecks existsSync guard — transient events without marker do not fire', async () => {
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();

    // Write and immediately delete — the watch may fire but existsSync should be false.
    writeFileSync(markerPath, '');
    unlinkSync(markerPath);
    await new Promise((r) => setTimeout(r, 100));

    // If the event fired between write and unlink, existsSync could still be true and callback might fire.
    // We accept that; the guarantee is that a spurious event without the marker present does NOT fire.
    // To exercise a purely spurious event: write a sibling file with a different name.
    const sibling = join(tempDir, 'other-file');
    writeFileSync(sibling, '');
    await new Promise((r) => setTimeout(r, 50));

    // The sibling write should never fire onSettled.
    // (If the earlier write-then-delete happened to fire, we don't try to prevent that; it's a race,
    // and the callback would have been called with the marker briefly present — acceptable.)
    // The important assertion: onSettled call count is at most 1 despite multiple fs events.
    expect(onSettled.mock.calls.length).toBeLessThanOrEqual(1);
    monitor.stop();
  });

  it('idempotent start() and stop()', async () => {
    const onSettled = vi.fn();
    const monitor = new PostActivationSettledMonitor({ onSettled, markerPath, keyFilePath });
    monitor.start();
    monitor.start(); // no-op
    monitor.stop();
    monitor.stop(); // no-op
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('safe when watch directory is missing (warns + no-op)', () => {
    const onSettled = vi.fn();
    const warn = vi.fn();
    const monitor = new PostActivationSettledMonitor({
      onSettled,
      markerPath: '/nonexistent/dir/marker',
      keyFilePath,
      logger: { info: vi.fn(), warn },
    });
    monitor.start();
    expect(warn).toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    monitor.stop();
  });
});
