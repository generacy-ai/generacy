import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRetainedTunnelEvent,
  setRetainedTunnelEvent,
  clearRetainedTunnelEvent,
  isRetentionEligible,
  type RetainedStatus,
  type RetainedTunnelEvent,
} from '../routes/retained-tunnel-event.js';

function makeEvent(
  status: RetainedStatus,
  overrides: Partial<RetainedTunnelEvent> = {},
): RetainedTunnelEvent {
  return {
    event: 'cluster.vscode-tunnel',
    data: { status },
    timestamp: `2026-01-01T00:00:00.${String(Math.floor(Math.random() * 999)).padStart(3, '0')}Z`,
    status,
    ...overrides,
  };
}

describe('retained-tunnel-event', () => {
  beforeEach(() => {
    clearRetainedTunnelEvent();
  });

  describe('setRetainedTunnelEvent — precedence matrix', () => {
    it('empty slot + authorization_pending → stores pending', () => {
      const evt = makeEvent('authorization_pending');
      setRetainedTunnelEvent(evt);
      expect(getRetainedTunnelEvent()).toBe(evt);
    });

    it('empty slot + connected → stores connected', () => {
      const evt = makeEvent('connected');
      setRetainedTunnelEvent(evt);
      expect(getRetainedTunnelEvent()).toBe(evt);
    });

    it('empty slot + disconnected → stores disconnected', () => {
      const evt = makeEvent('disconnected');
      setRetainedTunnelEvent(evt);
      expect(getRetainedTunnelEvent()).toBe(evt);
    });

    it('empty slot + error → stores error', () => {
      const evt = makeEvent('error');
      setRetainedTunnelEvent(evt);
      expect(getRetainedTunnelEvent()).toBe(evt);
    });

    it('authorization_pending + connected → overwrites with connected', () => {
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      const winner = makeEvent('connected');
      setRetainedTunnelEvent(winner);
      expect(getRetainedTunnelEvent()).toBe(winner);
    });

    it('authorization_pending + disconnected → overwrites with disconnected', () => {
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      const winner = makeEvent('disconnected');
      setRetainedTunnelEvent(winner);
      expect(getRetainedTunnelEvent()).toBe(winner);
    });

    it('authorization_pending + error → overwrites with error', () => {
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      const winner = makeEvent('error');
      setRetainedTunnelEvent(winner);
      expect(getRetainedTunnelEvent()).toBe(winner);
    });

    it('authorization_pending + authorization_pending → latest wins', () => {
      const first = makeEvent('authorization_pending');
      setRetainedTunnelEvent(first);
      const second = makeEvent('authorization_pending');
      setRetainedTunnelEvent(second);
      expect(getRetainedTunnelEvent()).toBe(second);
    });

    it('connected + authorization_pending → keeps existing terminal', () => {
      const existing = makeEvent('connected');
      setRetainedTunnelEvent(existing);
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      expect(getRetainedTunnelEvent()).toBe(existing);
    });

    it('disconnected + authorization_pending → keeps existing terminal', () => {
      const existing = makeEvent('disconnected');
      setRetainedTunnelEvent(existing);
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      expect(getRetainedTunnelEvent()).toBe(existing);
    });

    it('error + authorization_pending → keeps existing terminal', () => {
      const existing = makeEvent('error');
      setRetainedTunnelEvent(existing);
      setRetainedTunnelEvent(makeEvent('authorization_pending'));
      expect(getRetainedTunnelEvent()).toBe(existing);
    });

    it('connected + disconnected → overwrites (latest terminal wins)', () => {
      setRetainedTunnelEvent(makeEvent('connected'));
      const winner = makeEvent('disconnected');
      setRetainedTunnelEvent(winner);
      expect(getRetainedTunnelEvent()).toBe(winner);
    });

    it('connected + error → overwrites (latest terminal wins)', () => {
      setRetainedTunnelEvent(makeEvent('connected'));
      const winner = makeEvent('error');
      setRetainedTunnelEvent(winner);
      expect(getRetainedTunnelEvent()).toBe(winner);
    });
  });

  describe('isRetentionEligible — lifecycle statuses', () => {
    it('accepts authorization_pending', () => {
      expect(isRetentionEligible({ status: 'authorization_pending' })).toEqual({
        eligible: true,
        status: 'authorization_pending',
      });
    });

    it('accepts connected', () => {
      expect(isRetentionEligible({ status: 'connected' })).toEqual({
        eligible: true,
        status: 'connected',
      });
    });

    it('accepts disconnected', () => {
      expect(isRetentionEligible({ status: 'disconnected' })).toEqual({
        eligible: true,
        status: 'disconnected',
      });
    });

    it('accepts lifecycle error (non-matching error field)', () => {
      expect(
        isRetentionEligible({
          status: 'error',
          error: 'code tunnel exited (code 1) before reaching connected state',
        }),
      ).toEqual({ eligible: true, status: 'error' });
    });

    it('accepts error without an error field', () => {
      expect(isRetentionEligible({ status: 'error' })).toEqual({
        eligible: true,
        status: 'error',
      });
    });
  });

  describe('isRetentionEligible — FR-006 non-lifecycle error markers', () => {
    it('rejects "tunnel unregister timed out"', () => {
      expect(
        isRetentionEligible({
          status: 'error',
          error: 'tunnel unregister timed out',
        }),
      ).toEqual({ eligible: false });
    });

    it('rejects "tunnel unregister exited with code <N>"', () => {
      expect(
        isRetentionEligible({
          status: 'error',
          error: 'tunnel unregister exited with code 2',
        }),
      ).toEqual({ eligible: false });
    });

    it('rejects "tunnel unregister failed: <msg>"', () => {
      expect(
        isRetentionEligible({
          status: 'error',
          error: 'tunnel unregister failed: something went wrong',
        }),
      ).toEqual({ eligible: false });
    });

    it('rejects "tunnel name collision"', () => {
      expect(
        isRetentionEligible({
          status: 'error',
          error: 'tunnel name collision',
        }),
      ).toEqual({ eligible: false });
    });
  });

  describe('isRetentionEligible — malformed and non-retained', () => {
    it('rejects malformed payload (missing status)', () => {
      expect(isRetentionEligible({})).toEqual({ eligible: false });
    });

    it('rejects payload where status is not a string', () => {
      expect(isRetentionEligible({ status: 42 })).toEqual({ eligible: false });
    });

    it('rejects starting status', () => {
      expect(isRetentionEligible({ status: 'starting' })).toEqual({
        eligible: false,
      });
    });

    it('rejects stopped status', () => {
      expect(isRetentionEligible({ status: 'stopped' })).toEqual({
        eligible: false,
      });
    });

    it('rejects null payload', () => {
      expect(isRetentionEligible(null)).toEqual({ eligible: false });
    });

    it('preserves passthrough fields on eligible payloads', () => {
      const result = isRetentionEligible({
        status: 'authorization_pending',
        deviceCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        tunnelName: 'g-abc',
      });
      expect(result).toEqual({
        eligible: true,
        status: 'authorization_pending',
      });
    });
  });

  describe('get / clear idempotency', () => {
    it('getRetainedTunnelEvent returns null on empty slot', () => {
      expect(getRetainedTunnelEvent()).toBeNull();
    });

    it('multiple get calls return the same reference', () => {
      const evt = makeEvent('authorization_pending');
      setRetainedTunnelEvent(evt);
      expect(getRetainedTunnelEvent()).toBe(getRetainedTunnelEvent());
    });

    it('clear is idempotent', () => {
      clearRetainedTunnelEvent();
      clearRetainedTunnelEvent();
      expect(getRetainedTunnelEvent()).toBeNull();
    });

    it('clear after set empties the slot', () => {
      setRetainedTunnelEvent(makeEvent('connected'));
      clearRetainedTunnelEvent();
      expect(getRetainedTunnelEvent()).toBeNull();
    });
  });
});
