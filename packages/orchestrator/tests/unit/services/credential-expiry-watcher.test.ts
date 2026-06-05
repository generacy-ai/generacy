import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialExpiryWatcher, readCredentialDescriptors } from '../../../src/services/credential-expiry-watcher.js';
import type { GitHubAuthHealthService } from '../../../src/services/github-auth-health.js';
import type { CredentialDescriptor } from '../../../src/types/github-auth.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockHealth() {
  return {
    setCredentials: vi.fn<(d: CredentialDescriptor[]) => void>(),
    maybeRequestRefresh: vi.fn<(id: string, reason: string) => boolean>().mockReturnValue(true),
  };
}

describe('CredentialExpiryWatcher', () => {
  let agencyDir: string;
  let clock: { value: number };
  let logger: ReturnType<typeof createMockLogger>;
  let health: ReturnType<typeof createMockHealth>;

  beforeEach(async () => {
    agencyDir = await mkdtemp(path.join(tmpdir(), 'cred-expiry-test-'));
    clock = { value: Date.parse('2026-06-05T02:00:00.000Z') };
    logger = createMockLogger();
    health = createMockHealth();
  });

  afterEach(async () => {
    await rm(agencyDir, { recursive: true, force: true });
  });

  function newWatcher(opts: Partial<{ nearExpiryWindowMs: number }> = {}) {
    return new CredentialExpiryWatcher({
      agencyDir,
      health: health as unknown as GitHubAuthHealthService,
      logger,
      tickIntervalMs: 60_000,
      nearExpiryWindowMs: opts.nearExpiryWindowMs ?? 5 * 60_000,
      now: () => clock.value,
    });
  }

  async function writeYaml(contents: string): Promise<void> {
    await writeFile(path.join(agencyDir, 'credentials.yaml'), contents, { mode: 0o600 });
  }

  it('no-ops when credentials.yaml is missing; warns once', async () => {
    const w = newWatcher();
    await w.tick();
    await w.tick();
    expect(health.setCredentials).not.toHaveBeenCalled();
    expect(health.maybeRequestRefresh).not.toHaveBeenCalled();
    const fileMissingWarns = logger.warn.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('credentials.yaml not present'),
    );
    expect(fileMissingWarns).toHaveLength(1);
  });

  it('requests refresh when github-app token has 4 min remaining', async () => {
    const fourMinFromNow = new Date(clock.value + 4 * 60_000).toISOString();
    await writeYaml(`credentials:\n  primary:\n    type: github-app\n    expiresAt: "${fourMinFromNow}"\n`);
    const w = newWatcher();
    await w.tick();
    expect(health.setCredentials).toHaveBeenCalledTimes(1);
    const [[descriptors]] = health.setCredentials.mock.calls;
    expect(descriptors).toEqual([
      { credentialId: 'primary', type: 'github-app', expiresAt: fourMinFromNow },
    ]);
    expect(health.maybeRequestRefresh).toHaveBeenCalledWith('primary', 'near-expiry');
  });

  it('does NOT request refresh when github-app token has 10 min remaining', async () => {
    const tenMinFromNow = new Date(clock.value + 10 * 60_000).toISOString();
    await writeYaml(`credentials:\n  primary:\n    type: github-app\n    expiresAt: "${tenMinFromNow}"\n`);
    const w = newWatcher();
    await w.tick();
    expect(health.maybeRequestRefresh).not.toHaveBeenCalled();
  });

  it('requests refresh for past-expiry tokens (remaining < 0)', async () => {
    const oneMinAgo = new Date(clock.value - 60_000).toISOString();
    await writeYaml(`credentials:\n  primary:\n    type: github-app\n    expiresAt: "${oneMinAgo}"\n`);
    const w = newWatcher();
    await w.tick();
    expect(health.maybeRequestRefresh).toHaveBeenCalledWith('primary', 'near-expiry');
  });

  it('mtime change between ticks triggers setCredentials a second time', async () => {
    const t1 = new Date(clock.value + 10 * 60_000).toISOString();
    await writeYaml(`credentials:\n  primary:\n    type: github-app\n    expiresAt: "${t1}"\n`);
    const w = newWatcher();
    await w.tick();
    expect(health.setCredentials).toHaveBeenCalledTimes(1);

    // No mtime change: tick does not re-invoke setCredentials
    await w.tick();
    expect(health.setCredentials).toHaveBeenCalledTimes(1);

    // Wait for mtime granularity to advance and rewrite
    await new Promise((r) => setTimeout(r, 50));
    const t2 = new Date(clock.value + 20 * 60_000).toISOString();
    await writeYaml(`credentials:\n  primary:\n    type: github-app\n    expiresAt: "${t2}"\n`);
    await w.tick();
    expect(health.setCredentials).toHaveBeenCalledTimes(2);
  });

  it('survives parser error: logs warn and leaves watcher running', async () => {
    await writeYaml('this: is: not: valid: yaml: {{{');
    const w = newWatcher();
    await w.tick();
    expect(health.setCredentials).not.toHaveBeenCalled();
    const parseFails = logger.warn.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('Failed to parse credentials.yaml'),
    );
    expect(parseFails).toHaveLength(1);
  });

  it('skips non-github-app credentials for near-expiry check', async () => {
    const fourMinFromNow = new Date(clock.value + 4 * 60_000).toISOString();
    await writeYaml(
      `credentials:\n  ghapp:\n    type: github-app\n    expiresAt: "${fourMinFromNow}"\n  api:\n    type: api-key\n    expiresAt: "${fourMinFromNow}"\n`,
    );
    const w = newWatcher();
    await w.tick();
    expect(health.maybeRequestRefresh).toHaveBeenCalledTimes(1);
    expect(health.maybeRequestRefresh).toHaveBeenCalledWith('ghapp', 'near-expiry');
  });

  it('start() + stop() lifecycle does not throw and does not leak timer', async () => {
    const w = newWatcher();
    w.start();
    w.start(); // idempotent
    await w.stop();
    await w.stop(); // idempotent
  });
});

describe('readCredentialDescriptors', () => {
  let agencyDir: string;

  beforeEach(async () => {
    agencyDir = await mkdtemp(path.join(tmpdir(), 'cred-read-test-'));
  });

  afterEach(async () => {
    await rm(agencyDir, { recursive: true, force: true });
  });

  it('returns [] when file is missing', async () => {
    expect(await readCredentialDescriptors(agencyDir)).toEqual([]);
  });

  it('parses credentials and returns descriptors', async () => {
    await writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      `credentials:\n  primary:\n    type: github-app\n    expiresAt: "2030-01-01T00:00:00.000Z"\n`,
    );
    const descriptors = await readCredentialDescriptors(agencyDir);
    expect(descriptors).toEqual([
      { credentialId: 'primary', type: 'github-app', expiresAt: '2030-01-01T00:00:00.000Z' },
    ]);
  });

  it('returns [] on parser error', async () => {
    await writeFile(path.join(agencyDir, 'credentials.yaml'), 'this: is: not: valid: yaml: {{{');
    expect(await readCredentialDescriptors(agencyDir)).toEqual([]);
  });
});
