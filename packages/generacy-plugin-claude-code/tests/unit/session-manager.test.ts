/**
 * Unit tests for SessionManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionNotFoundError } from '../../src/errors.js';
import type { ContainerConfig } from '../../src/types.js';

const createMockLogger = (): Logger =>
  ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

const createTestConfig = (): ContainerConfig => ({
  image: 'test-image:latest',
  workdir: '/workspace',
  env: {},
  mounts: [],
  network: 'test-network',
});

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    manager = new SessionManager(mockLogger, {
      sessionTimeoutMs: 60000,
      cleanupIntervalMs: 1000,
      maxSessions: 10,
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('create', () => {
    it('should create a new session', () => {
      const session = manager.create({ containerConfig: createTestConfig() });

      expect(session.id).toBeDefined();
      expect(session.status).toBe('created');
    });

    it('should register session for retrieval', () => {
      const session = manager.create({ containerConfig: createTestConfig() });

      expect(manager.has(session.id)).toBe(true);
      expect(manager.get(session.id)).toBe(session);
    });

    it('should throw when max sessions reached', () => {
      // Fill up to max
      for (let i = 0; i < 10; i++) {
        manager.create({ containerConfig: createTestConfig() });
      }

      expect(() => manager.create({ containerConfig: createTestConfig() })).toThrow(
        'Maximum sessions (10) reached'
      );
    });

    it('should cleanup expired sessions when max reached', () => {
      // Create sessions and terminate some
      const sessions = [];
      for (let i = 0; i < 10; i++) {
        sessions.push(manager.create({ containerConfig: createTestConfig() }));
      }

      // Terminate half and make them appear old
      for (let i = 0; i < 5; i++) {
        manager.terminate(sessions[i]!.id, 'user_requested');
        // Make terminated session appear old (past grace period)
        Object.defineProperty(sessions[i], 'lastActiveAt', {
          get: () => new Date(Date.now() - 120000), // 2 minutes ago
        });
      }

      // Force cleanup
      manager.cleanupExpiredSessions();

      // Should be able to create more now
      const newSession = manager.create({ containerConfig: createTestConfig() });
      expect(newSession).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return session by id', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      const retrieved = manager.get(session.id);

      expect(retrieved).toBe(session);
    });

    it('should throw SessionNotFoundError for unknown id', () => {
      expect(() => manager.get('unknown-id')).toThrow(SessionNotFoundError);
    });
  });

  describe('find', () => {
    it('should return session or undefined', () => {
      const session = manager.create({ containerConfig: createTestConfig() });

      expect(manager.find(session.id)).toBe(session);
      expect(manager.find('unknown-id')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should check if session exists', () => {
      const session = manager.create({ containerConfig: createTestConfig() });

      expect(manager.has(session.id)).toBe(true);
      expect(manager.has('unknown-id')).toBe(false);
    });
  });

  describe('state transitions', () => {
    it('should handle container started', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.onContainerStarted(session.id, 'container-123');

      expect(session.status).toBe('running');
      expect(session.containerId).toBe('container-123');
    });

    it('should handle invocation started', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.onContainerStarted(session.id, 'container-123');
      manager.onInvocationStarted(session.id, 'invocation-456');

      expect(session.status).toBe('executing');
    });

    it('should handle invocation completed', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.onContainerStarted(session.id, 'container-123');
      manager.onInvocationStarted(session.id, 'invocation-456');
      manager.onInvocationCompleted(session.id);

      expect(session.status).toBe('running');
    });

    it('should handle question received', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.onContainerStarted(session.id, 'container-123');
      manager.onInvocationStarted(session.id, 'invocation-456');
      manager.onQuestionReceived(session.id, {
        question: 'Test question?',
        urgency: 'blocking_now',
        askedAt: new Date(),
      });

      expect(session.status).toBe('awaiting_input');
    });

    it('should handle answer provided', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.onContainerStarted(session.id, 'container-123');
      manager.onInvocationStarted(session.id, 'invocation-456');
      manager.onQuestionReceived(session.id, {
        question: 'Test question?',
        urgency: 'blocking_now',
        askedAt: new Date(),
      });
      manager.onAnswerProvided(session.id);

      expect(session.status).toBe('running');
    });

    it('should handle termination', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.terminate(session.id, 'user_requested');

      expect(session.status).toBe('terminated');
      expect(session.isActive()).toBe(false);
    });

    it('should not throw for unknown session termination', () => {
      expect(() => manager.terminate('unknown-id', 'user_requested')).not.toThrow();
    });
  });

  describe('listing', () => {
    it('should list active sessions', () => {
      const session1 = manager.create({ containerConfig: createTestConfig() });
      const session2 = manager.create({ containerConfig: createTestConfig() });
      manager.terminate(session2.id, 'user_requested');

      const active = manager.listActive();

      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(session1.id);
    });

    it('should list all sessions', () => {
      manager.create({ containerConfig: createTestConfig() });
      const session2 = manager.create({ containerConfig: createTestConfig() });
      manager.terminate(session2.id, 'user_requested');

      const all = manager.listAll();

      expect(all).toHaveLength(2);
    });

    it('should get active count', () => {
      manager.create({ containerConfig: createTestConfig() });
      const session2 = manager.create({ containerConfig: createTestConfig() });
      manager.terminate(session2.id, 'user_requested');

      expect(manager.getActiveCount()).toBe(1);
    });

    it('should get total count', () => {
      manager.create({ containerConfig: createTestConfig() });
      manager.create({ containerConfig: createTestConfig() });

      expect(manager.getTotalCount()).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should remove session', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      const removed = manager.remove(session.id);

      expect(removed).toBe(true);
      expect(manager.has(session.id)).toBe(false);
    });

    it('should return false for unknown session', () => {
      const removed = manager.remove('unknown-id');

      expect(removed).toBe(false);
    });

    it('should cleanup terminated sessions', () => {
      const session = manager.create({ containerConfig: createTestConfig() });
      manager.terminate(session.id, 'user_requested');

      // Terminated sessions are cleaned up after grace period
      // Force cleanup by making session appear old
      Object.defineProperty(session, 'lastActiveAt', {
        get: () => new Date(Date.now() - 120000), // 2 minutes ago
      });

      const count = manager.cleanupExpiredSessions();

      expect(count).toBe(1);
      expect(manager.has(session.id)).toBe(false);
    });

    it('should cleanup all sessions on dispose', () => {
      manager.create({ containerConfig: createTestConfig() });
      manager.create({ containerConfig: createTestConfig() });

      manager.dispose();

      expect(manager.getTotalCount()).toBe(0);
    });
  });
});
