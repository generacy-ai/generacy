import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliSpawner } from '../../worker/cli-spawner.js';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import type { OutputCapture } from '../../worker/output-capture.js';

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeFakeProcess() {
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    pid: 42,
    kill: vi.fn(),
    exitPromise: Promise.resolve(0),
  };
}

function makeFakeLauncher() {
  const launchMock = vi.fn().mockResolvedValue({
    process: makeFakeProcess(),
    outputParser: undefined,
    metadata: { pluginId: 'test', intentKind: 'phase' },
  });
  return {
    launch: launchMock,
    registerPlugin: vi.fn(),
  } as unknown as AgentLauncher & { launch: ReturnType<typeof vi.fn> };
}

function makeFakeCapture() {
  return {
    processChunk: vi.fn(),
    flush: vi.fn(),
    getOutput: vi.fn().mockReturnValue([]),
    sessionId: undefined,
    implementResult: undefined,
  } as unknown as OutputCapture;
}

describe('CliSpawner credentials', () => {
  let launcher: ReturnType<typeof makeFakeLauncher>;
  let logger: ReturnType<typeof makeFakeLogger>;

  beforeEach(() => {
    launcher = makeFakeLauncher();
    logger = makeFakeLogger();
  });

  describe('spawnPhase()', () => {
    it('should include credentials when credentialRole is set', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000, 'developer');
      const signal = new AbortController().signal;

      await spawner.spawnPhase('implement', {
        cwd: '/tmp',
        prompt: 'test',
        timeoutMs: 60000,
        signal,
      }, makeFakeCapture());

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            role: 'developer',
            uid: expect.any(Number),
            gid: expect.any(Number),
          }),
        }),
      );
    });

    it('should omit credentials when credentialRole is undefined', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000);
      const signal = new AbortController().signal;

      await spawner.spawnPhase('implement', {
        cwd: '/tmp',
        prompt: 'test',
        timeoutMs: 60000,
        signal,
      }, makeFakeCapture());

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: undefined,
        }),
      );
    });
  });

  describe('runValidatePhase()', () => {
    it('should include credentials when credentialRole is set', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000, 'ci-runner');
      const signal = new AbortController().signal;

      await spawner.runValidatePhase('/tmp', 'pnpm test', signal);

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            role: 'ci-runner',
          }),
        }),
      );
    });

    it('should omit credentials when credentialRole is undefined', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000);
      const signal = new AbortController().signal;

      await spawner.runValidatePhase('/tmp', 'pnpm test', signal);

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: undefined,
        }),
      );
    });
  });

  describe('runPreValidateInstall()', () => {
    it('should include credentials when credentialRole is set', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000, 'developer');
      const signal = new AbortController().signal;

      await spawner.runPreValidateInstall('/tmp', 'pnpm install', signal);

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            role: 'developer',
          }),
        }),
      );
    });

    it('should omit credentials when credentialRole is undefined', async () => {
      const spawner = new CliSpawner(launcher, logger, 5000);
      const signal = new AbortController().signal;

      await spawner.runPreValidateInstall('/tmp', 'pnpm install', signal);

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: undefined,
        }),
      );
    });
  });
});
