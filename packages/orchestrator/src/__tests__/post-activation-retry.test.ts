import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => true),
}));

import { PostActivationRetryService } from '../services/post-activation-retry.js';
import { probeControlPlaneSocket } from '../services/control-plane-probe.js';

const mockProbe = vi.mocked(probeControlPlaneSocket);

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    level: 'info',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('PostActivationRetryService', () => {
  let tempDir: string;
  let logger: FastifyBaseLogger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'post-activation-test-'));
    logger = createMockLogger();
    mockProbe.mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('checkPostActivationState', () => {
    it('returns needsRetry: false when no API key exists', () => {
      const service = new PostActivationRetryService({
        logger,
        keyFilePath: join(tempDir, 'cluster-api-key'),
        completionFlagPath: join(tempDir, 'post-activation-complete'),
      });

      const state = service.checkPostActivationState();

      expect(state).toEqual({
        activated: false,
        postActivationComplete: false,
        needsRetry: false,
      });
    });

    it('returns needsRetry: false when both API key and completion flag exist', () => {
      const keyPath = join(tempDir, 'cluster-api-key');
      const flagPath = join(tempDir, 'post-activation-complete');
      writeFileSync(keyPath, 'test-key');
      writeFileSync(flagPath, '');

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: keyPath,
        completionFlagPath: flagPath,
      });

      const state = service.checkPostActivationState();

      expect(state).toEqual({
        activated: true,
        postActivationComplete: true,
        needsRetry: false,
      });
    });

    it('returns needsRetry: true when API key exists but completion flag is absent', () => {
      const keyPath = join(tempDir, 'cluster-api-key');
      const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
      writeFileSync(keyPath, 'test-key');
      writeFileSync(wizardCredsPath, 'GH_TOKEN=ghp_valid\n');

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: keyPath,
        completionFlagPath: join(tempDir, 'post-activation-complete'),
        wizardCredsPath,
      });

      const state = service.checkPostActivationState();

      expect(state).toEqual({
        activated: true,
        postActivationComplete: false,
        needsRetry: true,
      });
    });

    // RT-001: fresh wizard cluster — activated && !complete, but no sealed
    // GH_TOKEN yet. The retry MUST defer (needsRetry === false), emit the
    // FR-002 log line, and emit the cluster.bootstrap `deferred` relay event.
    describe('GH_TOKEN gate (RT-001)', () => {
      it('defers when wizard-credentials.env is missing entirely', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        writeFileSync(keyPath, 'test-key');
        const wizardCredsPath = join(tempDir, 'missing-wizard-credentials.env');
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        const state = service.checkPostActivationState();

        expect(state).toEqual({
          activated: true,
          postActivationComplete: false,
          needsRetry: false,
        });
        expect(logger.info).toHaveBeenCalledWith(
          { wizardCredsPath },
          expect.stringMatching(/GH_TOKEN not sealed/),
        );
        expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', {
          status: 'deferred',
          reason: 'github-token-not-sealed',
        });
      });

      it('defers when GH_TOKEN key is absent from the file', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
        writeFileSync(keyPath, 'test-key');
        writeFileSync(
          wizardCredsPath,
          'ANTHROPIC_API_KEY=sk-ant-xxx\nGH_USERNAME=octocat\n',
        );
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        const state = service.checkPostActivationState();

        expect(state.needsRetry).toBe(false);
        expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', {
          status: 'deferred',
          reason: 'github-token-not-sealed',
        });
      });

      it('defers when GH_TOKEN is present but empty (trimmed)', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
        writeFileSync(keyPath, 'test-key');
        writeFileSync(wizardCredsPath, 'GH_TOKEN=   \n');
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        const state = service.checkPostActivationState();

        expect(state.needsRetry).toBe(false);
        expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', {
          status: 'deferred',
          reason: 'github-token-not-sealed',
        });
      });

      it('does not throw on I/O errors — treats as not sealed', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        writeFileSync(keyPath, 'test-key');
        // Point at the temp directory itself — readFileSync will EISDIR.
        const wizardCredsPath = tempDir;
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        expect(() => service.checkPostActivationState()).not.toThrow();
        const state = service.checkPostActivationState();
        expect(state.needsRetry).toBe(false);
      });

      it('does not emit the defer event when !activated', () => {
        const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
        // no api-key file → not activated
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: join(tempDir, 'cluster-api-key'),
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        service.checkPostActivationState();
        expect(sendRelayEvent).not.toHaveBeenCalled();
      });

      it('does not emit the defer event when postActivationComplete is true', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        const flagPath = join(tempDir, 'post-activation-complete');
        const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
        writeFileSync(keyPath, 'test-key');
        writeFileSync(flagPath, '');
        // no GH_TOKEN — but complete flag is set, so no defer signal
        const sendRelayEvent = vi.fn();

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: flagPath,
          wizardCredsPath,
          sendRelayEvent,
        });

        service.checkPostActivationState();
        expect(sendRelayEvent).not.toHaveBeenCalled();
      });
    });

    // RT-002: restart-recovery preserved — sealed GH_TOKEN present, still
    // needsRetry === true, no defer event emitted.
    describe('GH_TOKEN present (RT-002)', () => {
      it('returns needsRetry: true and emits no defer event when GH_TOKEN is sealed', () => {
        const keyPath = join(tempDir, 'cluster-api-key');
        const wizardCredsPath = join(tempDir, 'wizard-credentials.env');
        writeFileSync(keyPath, 'test-key');
        writeFileSync(
          wizardCredsPath,
          'GH_USERNAME=octocat\nGH_TOKEN=ghp_1234567890abcdef\nGH_EMAIL=octocat@example.com\n',
        );
        const sendRelayEvent = vi.fn();
        const infoSpy = vi.mocked(logger.info);

        const service = new PostActivationRetryService({
          logger,
          keyFilePath: keyPath,
          completionFlagPath: join(tempDir, 'post-activation-complete'),
          wizardCredsPath,
          sendRelayEvent,
        });

        const state = service.checkPostActivationState();

        expect(state).toEqual({
          activated: true,
          postActivationComplete: false,
          needsRetry: true,
        });
        expect(sendRelayEvent).not.toHaveBeenCalled();
        for (const call of infoSpy.mock.calls) {
          const message = call[1];
          if (typeof message === 'string') {
            expect(message).not.toMatch(/GH_TOKEN not sealed/);
          }
        }
      });
    });
  });

  describe('triggerPostActivationRetry', () => {
    let socketPath: string;
    let mockServer: http.Server;
    let lastRequest: { path: string; method: string; headers: Record<string, string>; body: string } | null;

    beforeEach((ctx) => {
      socketPath = join(tempDir, 'control-plane.sock');
      lastRequest = null;

      mockServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          lastRequest = {
            path: req.url ?? '',
            method: req.method ?? '',
            headers: req.headers as Record<string, string>,
            body,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));
        });
      });

      return new Promise<void>((resolve) => {
        mockServer.listen(socketPath, resolve);
      });
    });

    afterEach(() => {
      return new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
    });

    it('sends POST /lifecycle/bootstrap-complete with correct headers and body', async () => {
      mockProbe.mockResolvedValue(true);
      const sendRelayEvent = vi.fn();

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: join(tempDir, 'cluster-api-key'),
        completionFlagPath: join(tempDir, 'post-activation-complete'),
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerPostActivationRetry();

      expect(lastRequest).not.toBeNull();
      expect(lastRequest!.path).toBe('/lifecycle/bootstrap-complete');
      expect(lastRequest!.method).toBe('POST');
      expect(lastRequest!.headers['x-generacy-actor-user-id']).toBe('system');
      expect(lastRequest!.headers['x-generacy-actor-session-id']).toBe('post-activation-retry');
      expect(JSON.parse(lastRequest!.body)).toEqual({ action: 'bootstrap-complete' });
    });

    it('emits retrying relay event before the HTTP call', async () => {
      mockProbe.mockResolvedValue(true);
      const sendRelayEvent = vi.fn();

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: join(tempDir, 'cluster-api-key'),
        completionFlagPath: join(tempDir, 'post-activation-complete'),
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerPostActivationRetry();

      expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', {
        status: 'retrying',
        reason: 'post-activation-incomplete',
        attempt: 'restart',
      });
      // retrying event should be first call
      expect(sendRelayEvent.mock.calls[0]).toEqual([
        'cluster.bootstrap',
        { status: 'retrying', reason: 'post-activation-incomplete', attempt: 'restart' },
      ]);
    });
  });

  describe('retry failure path', () => {
    it('pushes degraded status and emits failure event when HTTP call fails', async () => {
      // Create a server that returns 500
      const socketPath = join(tempDir, 'failing.sock');
      const failServer = http.createServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      });

      await new Promise<void>((resolve) => failServer.listen(socketPath, resolve));

      mockProbe.mockResolvedValue(true);
      const sendRelayEvent = vi.fn();

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: join(tempDir, 'cluster-api-key'),
        completionFlagPath: join(tempDir, 'post-activation-complete'),
        controlPlaneSocket: socketPath,
        controlPlaneWaitTimeout: 2,
        sendRelayEvent,
      });

      await service.triggerPostActivationRetry();

      // Should emit failure event
      expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', expect.objectContaining({
        status: 'failed',
        reason: 'lifecycle-action-failed',
      }));

      // Should log error
      expect(logger.error).toHaveBeenCalled();

      await new Promise<void>((resolve) => failServer.close(() => resolve()));
    });

    it('pushes degraded status when control-plane socket is unreachable', async () => {
      mockProbe.mockResolvedValue(false);
      const sendRelayEvent = vi.fn();

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: join(tempDir, 'cluster-api-key'),
        completionFlagPath: join(tempDir, 'post-activation-complete'),
        controlPlaneSocket: join(tempDir, 'nonexistent.sock'),
        controlPlaneWaitTimeout: 1,
        sendRelayEvent,
      });

      await service.triggerPostActivationRetry();

      expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', expect.objectContaining({
        status: 'failed',
        reason: 'control-plane-unreachable',
      }));

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('multi-restart no-op', () => {
    it('does not trigger retry when API key and completion flag both exist', () => {
      const keyPath = join(tempDir, 'cluster-api-key');
      const flagPath = join(tempDir, 'post-activation-complete');
      writeFileSync(keyPath, 'test-key');
      writeFileSync(flagPath, '');

      const service = new PostActivationRetryService({
        logger,
        keyFilePath: keyPath,
        completionFlagPath: flagPath,
      });

      const state = service.checkPostActivationState();
      expect(state.needsRetry).toBe(false);

      // triggerPostActivationRetry() should never be called in this case
      // (the caller checks needsRetry before calling)
    });
  });
});
