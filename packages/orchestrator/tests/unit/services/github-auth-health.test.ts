import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubAuthHealthService } from '../../../src/services/github-auth-health.js';
import type { CredentialsEventPayload } from '../../../src/types/github-auth.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

describe('GitHubAuthHealthService', () => {
  let clock: { value: number };
  let emitted: CredentialsEventPayload[];
  let emit: (payload: CredentialsEventPayload) => void;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    clock = { value: 1_700_000_000_000 };
    emitted = [];
    emit = (p) => emitted.push(p);
    logger = createMockLogger();
  });

  function newService(opts: { minRefreshIntervalMs?: number } = {}) {
    return new GitHubAuthHealthService({
      emitEvent: emit,
      logger,
      now: () => clock.value,
      minRefreshIntervalMs: opts.minRefreshIntervalMs,
    });
  }

  describe('state machine', () => {
    it('unknown → ok on first success, emits nothing', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: true });
      expect(emitted).toEqual([]);
      expect(svc.snapshot()).toMatchObject({
        status: 'ok',
        consecutiveFailures: 0,
        credentialId: 'a',
      });
    });

    it('unknown → failing on first 401, emits auth-failed', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: false, statusCode: 401 });

      const transitions = emitted.filter((e) => e.action === 'auth-failed');
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        action: 'auth-failed',
        credentialId: 'a',
        type: 'github-app',
        consecutiveFailures: 1,
      });
      expect(svc.snapshot()).toMatchObject({
        status: 'failing',
        consecutiveFailures: 1,
      });
    });

    it('ok → failing on 401 (consecutiveFailures resets to 1)', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: true });
      svc.recordResult('a', { ok: false, statusCode: 401 });
      const t = emitted.find((e) => e.action === 'auth-failed');
      expect(t).toMatchObject({ consecutiveFailures: 1 });
    });

    it('failing → ok emits auth-recovered with recoveredAfterFailures', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: false, statusCode: 401 });
      svc.recordResult('a', { ok: false, statusCode: 401 });
      emitted.length = 0;
      svc.recordResult('a', { ok: true });
      expect(emitted).toEqual([
        expect.objectContaining({
          action: 'auth-recovered',
          credentialId: 'a',
          recoveredAfterFailures: 2,
        }),
      ]);
      expect(svc.snapshot()).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    });

    it('failing → failing increments counter but emits no auth-failed', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: false, statusCode: 401 });
      const authFailed1 = emitted.filter((e) => e.action === 'auth-failed').length;
      clock.value += 100_000;
      svc.recordResult('a', { ok: false, statusCode: 401 });
      const authFailed2 = emitted.filter((e) => e.action === 'auth-failed').length;
      expect(authFailed2).toBe(authFailed1);
      expect(svc.snapshot()).toMatchObject({ consecutiveFailures: 2 });
    });

    it('non-401 failures do not transition state', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: true });
      svc.recordResult('a', { ok: false, statusCode: 500 });
      expect(svc.snapshot()).toMatchObject({ status: 'ok' });
    });

    it('setCredentials([]) clears entries', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: false, statusCode: 401 });
      svc.setCredentials([]);
      expect(svc.snapshot()).toEqual({ status: 'unknown', consecutiveFailures: 0 });
    });
  });

  describe('snapshot selection', () => {
    it('returns failing over ok', () => {
      const svc = newService();
      svc.setCredentials([
        { credentialId: 'b', type: 'github-app' },
        { credentialId: 'a', type: 'github-app' },
      ]);
      svc.recordResult('a', { ok: true });
      svc.recordResult('b', { ok: false, statusCode: 401 });
      expect(svc.snapshot()).toMatchObject({ credentialId: 'b', status: 'failing' });
    });

    it('returns ok over unknown', () => {
      const svc = newService();
      svc.setCredentials([
        { credentialId: 'a', type: 'github-app' },
        { credentialId: 'b', type: 'github-app' },
      ]);
      svc.recordResult('b', { ok: true });
      expect(svc.snapshot()).toMatchObject({ credentialId: 'b', status: 'ok' });
    });

    it('uses lexicographic tiebreak among same-status entries', () => {
      const svc = newService();
      svc.setCredentials([
        { credentialId: 'zebra', type: 'github-app' },
        { credentialId: 'alpha', type: 'github-app' },
      ]);
      svc.recordResult('zebra', { ok: false, statusCode: 401 });
      svc.recordResult('alpha', { ok: false, statusCode: 401 });
      expect(svc.snapshot()).toMatchObject({ credentialId: 'alpha' });
    });

    it('returns unknown shape when no credentials present', () => {
      const svc = newService();
      expect(svc.snapshot()).toEqual({ status: 'unknown', consecutiveFailures: 0 });
    });
  });

  describe('refresh rate limit', () => {
    it('emits at most one refresh-requested per 60s, then a second after 61s', () => {
      const svc = newService({ minRefreshIntervalMs: 60_000 });
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);

      // 3 calls within 30s
      svc.maybeRequestRefresh('a', 'near-expiry');
      clock.value += 10_000;
      svc.maybeRequestRefresh('a', 'near-expiry');
      clock.value += 10_000;
      svc.maybeRequestRefresh('a', 'near-expiry');

      const refresh1 = emitted.filter((e) => e.action === 'refresh-requested').length;
      expect(refresh1).toBe(1);

      // Advance >60s
      clock.value += 41_000;
      svc.maybeRequestRefresh('a', 'near-expiry');
      const refresh2 = emitted.filter((e) => e.action === 'refresh-requested').length;
      expect(refresh2).toBe(2);
    });

    it('401 transition also calls maybeRequestRefresh (auth-401)', () => {
      const svc = newService();
      svc.setCredentials([{ credentialId: 'a', type: 'github-app' }]);
      svc.recordResult('a', { ok: false, statusCode: 401 });
      const refresh = emitted.filter((e) => e.action === 'refresh-requested');
      expect(refresh).toHaveLength(1);
      expect(refresh[0]).toMatchObject({ reason: 'auth-401' });
    });
  });

  describe('expiresAt mirroring', () => {
    it('expiresAt from setCredentials appears in snapshot', () => {
      const svc = newService();
      svc.setCredentials([
        { credentialId: 'a', type: 'github-app', expiresAt: '2030-01-01T00:00:00.000Z' },
      ]);
      svc.recordResult('a', { ok: true });
      const snap = svc.snapshot();
      expect(snap.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });
  });
});
