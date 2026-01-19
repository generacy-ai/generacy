import { describe, it, expect } from 'vitest';
import {
  determineRoute,
  validateMessageForRouting,
  expectsResponse,
  getSourceTypeConstraint,
  RoutingError,
} from '../../src/router/routing-rules.js';
import type { MessageEnvelope } from '../../src/types/messages.js';

describe('determineRoute', () => {
  it('routes decision_request to broadcast_humancy', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'decision_request',
      source: { type: 'agency', id: 'agency-1' },
      payload: { question: 'approve?' },
      meta: { timestamp: Date.now() },
    };

    const decision = determineRoute(message);

    expect(decision.target).toBe('broadcast_humancy');
    expect(decision.expectsResponse).toBe(true);
  });

  it('routes decision_response to specific agency', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'decision_response',
      correlationId: 'corr-1',
      source: { type: 'humancy', id: 'humancy-1' },
      destination: { type: 'agency', id: 'agency-1' },
      payload: { approved: true },
      meta: { timestamp: Date.now() },
    };

    const decision = determineRoute(message);

    expect(decision.target).toBe('agency');
    expect(decision.targetId).toBe('agency-1');
    expect(decision.expectsResponse).toBe(false);
  });

  it('throws when decision_response has no destination', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'decision_response',
      source: { type: 'humancy', id: 'humancy-1' },
      payload: { approved: true },
      meta: { timestamp: Date.now() },
    };

    expect(() => determineRoute(message)).toThrow(RoutingError);
  });

  it('routes mode_command to specific agency', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'mode_command',
      source: { type: 'router', id: 'router-1' },
      destination: { type: 'agency', id: 'agency-1' },
      payload: { mode: 'pause' },
      meta: { timestamp: Date.now() },
    };

    const decision = determineRoute(message);

    expect(decision.target).toBe('agency');
    expect(decision.targetId).toBe('agency-1');
    expect(decision.expectsResponse).toBe(false);
  });

  it('throws when mode_command has no destination', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'mode_command',
      source: { type: 'router', id: 'router-1' },
      payload: { mode: 'pause' },
      meta: { timestamp: Date.now() },
    };

    expect(() => determineRoute(message)).toThrow(RoutingError);
  });

  it('routes workflow_event to broadcast_humancy', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'workflow_event',
      source: { type: 'router', id: 'router-1' },
      payload: { event: 'completed' },
      meta: { timestamp: Date.now() },
    };

    const decision = determineRoute(message);

    expect(decision.target).toBe('broadcast_humancy');
    expect(decision.expectsResponse).toBe(false);
  });

  it('routes channel_message to channel', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'channel_message',
      channel: 'notifications',
      source: { type: 'agency', id: 'agency-1' },
      payload: { notification: 'test' },
      meta: { timestamp: Date.now() },
    };

    const decision = determineRoute(message);

    expect(decision.target).toBe('channel');
    expect(decision.targetId).toBe('notifications');
    expect(decision.expectsResponse).toBe(false);
  });

  it('throws when channel_message has no channel', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'channel_message',
      source: { type: 'agency', id: 'agency-1' },
      payload: { notification: 'test' },
      meta: { timestamp: Date.now() },
    };

    expect(() => determineRoute(message)).toThrow(RoutingError);
  });
});

describe('validateMessageForRouting', () => {
  it('validates a valid message', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'decision_request',
      source: { type: 'agency', id: 'agency-1' },
      payload: {},
      meta: { timestamp: Date.now() },
    };

    expect(() => validateMessageForRouting(message)).not.toThrow();
  });

  it('throws when message has no id', () => {
    const message = {
      type: 'decision_request',
      source: { type: 'agency', id: 'agency-1' },
      payload: {},
      meta: { timestamp: Date.now() },
    } as MessageEnvelope;

    expect(() => validateMessageForRouting(message)).toThrow(RoutingError);
  });

  it('throws when message has no type', () => {
    const message = {
      id: 'msg-1',
      source: { type: 'agency', id: 'agency-1' },
      payload: {},
      meta: { timestamp: Date.now() },
    } as MessageEnvelope;

    expect(() => validateMessageForRouting(message)).toThrow(RoutingError);
  });

  it('throws when message has no source', () => {
    const message = {
      id: 'msg-1',
      type: 'decision_request',
      payload: {},
      meta: { timestamp: Date.now() },
    } as MessageEnvelope;

    expect(() => validateMessageForRouting(message)).toThrow(RoutingError);
  });

  it('throws when decision_response has no correlationId', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'decision_response',
      source: { type: 'humancy', id: 'humancy-1' },
      destination: { type: 'agency', id: 'agency-1' },
      payload: {},
      meta: { timestamp: Date.now() },
    };

    expect(() => validateMessageForRouting(message)).toThrow(RoutingError);
  });

  it('throws when channel_message has no channel', () => {
    const message: MessageEnvelope = {
      id: 'msg-1',
      type: 'channel_message',
      source: { type: 'agency', id: 'agency-1' },
      payload: {},
      meta: { timestamp: Date.now() },
    };

    expect(() => validateMessageForRouting(message)).toThrow(RoutingError);
  });
});

describe('expectsResponse', () => {
  it('returns true for decision_request', () => {
    expect(expectsResponse('decision_request')).toBe(true);
  });

  it('returns false for decision_response', () => {
    expect(expectsResponse('decision_response')).toBe(false);
  });

  it('returns false for mode_command', () => {
    expect(expectsResponse('mode_command')).toBe(false);
  });

  it('returns false for workflow_event', () => {
    expect(expectsResponse('workflow_event')).toBe(false);
  });

  it('returns false for channel_message', () => {
    expect(expectsResponse('channel_message')).toBe(false);
  });
});

describe('getSourceTypeConstraint', () => {
  it('returns agency for decision_request', () => {
    expect(getSourceTypeConstraint('decision_request')).toBe('agency');
  });

  it('returns humancy for decision_response', () => {
    expect(getSourceTypeConstraint('decision_response')).toBe('humancy');
  });

  it('returns router for mode_command', () => {
    expect(getSourceTypeConstraint('mode_command')).toBe('router');
  });

  it('returns router for workflow_event', () => {
    expect(getSourceTypeConstraint('workflow_event')).toBe('router');
  });

  it('returns null for channel_message', () => {
    expect(getSourceTypeConstraint('channel_message')).toBeNull();
  });
});
