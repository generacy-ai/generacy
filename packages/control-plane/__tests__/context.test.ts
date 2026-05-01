import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { extractActorContext, requireActor } from '../src/context.js';
import { ControlPlaneError } from '../src/errors.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) clean[k] = v;
  }
  return { headers: clean } as unknown as IncomingMessage;
}

describe('extractActorContext', () => {
  it('returns userId and sessionId when both headers are present', () => {
    const req = fakeReq({
      'x-generacy-actor-user-id': 'u-123',
      'x-generacy-actor-session-id': 's-456',
    });
    expect(extractActorContext(req)).toEqual({
      userId: 'u-123',
      sessionId: 's-456',
    });
  });

  it('returns userId with sessionId undefined when only userId header is present', () => {
    const req = fakeReq({
      'x-generacy-actor-user-id': 'u-123',
    });
    expect(extractActorContext(req)).toEqual({
      userId: 'u-123',
      sessionId: undefined,
    });
  });

  it('returns sessionId with userId undefined when only sessionId header is present', () => {
    const req = fakeReq({
      'x-generacy-actor-session-id': 's-456',
    });
    expect(extractActorContext(req)).toEqual({
      userId: undefined,
      sessionId: 's-456',
    });
  });

  it('returns both fields undefined when no headers are present', () => {
    const req = fakeReq({});
    expect(extractActorContext(req)).toEqual({
      userId: undefined,
      sessionId: undefined,
    });
  });

  it('treats empty string headers as undefined', () => {
    const req = fakeReq({
      'x-generacy-actor-user-id': '',
      'x-generacy-actor-session-id': '',
    });
    expect(extractActorContext(req)).toEqual({
      userId: undefined,
      sessionId: undefined,
    });
  });
});

describe('requireActor', () => {
  it('does not throw when userId is present', () => {
    expect(() => requireActor({ userId: 'u-123' })).not.toThrow();
  });

  it('throws UNAUTHORIZED when userId is undefined', () => {
    expect(() => requireActor({})).toThrow(ControlPlaneError);
    try {
      requireActor({});
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });

  it('throws UNAUTHORIZED when userId is empty string', () => {
    expect(() => requireActor({ userId: '' })).toThrow(ControlPlaneError);
  });
});
