/**
 * Unit tests for Session state machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../src/session/session.js';
import { SessionInvalidStateError } from '../../src/errors.js';
import type { ContainerConfig, QuestionPayload } from '../../src/types.js';

const createTestConfig = (): ContainerConfig => ({
  image: 'test-image:latest',
  workdir: '/workspace',
  env: {},
  mounts: [],
  network: 'test-network',
});

const createTestQuestion = (): QuestionPayload => ({
  question: 'What do you want to do?',
  urgency: 'blocking_now',
  choices: ['Option A', 'Option B'],
  askedAt: new Date(),
});

describe('Session', () => {
  let session: Session;

  beforeEach(() => {
    session = new Session({ containerConfig: createTestConfig() });
  });

  describe('initial state', () => {
    it('should start in created state', () => {
      expect(session.status).toBe('created');
    });

    it('should have a unique id', () => {
      const session2 = new Session({ containerConfig: createTestConfig() });
      expect(session.id).not.toBe(session2.id);
    });

    it('should set createdAt and lastActiveAt', () => {
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActiveAt).toBeInstanceOf(Date);
    });

    it('should be active', () => {
      expect(session.isActive()).toBe(true);
    });

    it('should not be ready for invocation', () => {
      expect(session.isReadyForInvocation()).toBe(false);
    });
  });

  describe('withId', () => {
    it('should create session with specific id', () => {
      const session = Session.withId('custom-id', { containerConfig: createTestConfig() });
      expect(session.id).toBe('custom-id');
    });
  });

  describe('state transitions', () => {
    describe('created -> running', () => {
      it('should transition on container started', () => {
        session.onContainerStarted('container-123');

        expect(session.status).toBe('running');
        expect(session.containerId).toBe('container-123');
      });

      it('should be ready for invocation when running', () => {
        session.onContainerStarted('container-123');

        expect(session.isReadyForInvocation()).toBe(true);
      });
    });

    describe('running -> executing', () => {
      beforeEach(() => {
        session.onContainerStarted('container-123');
      });

      it('should transition on invocation started', () => {
        session.onInvocationStarted('invocation-456');

        expect(session.status).toBe('executing');
        expect(session.invocationId).toBe('invocation-456');
      });

      it('should not be ready for another invocation while executing', () => {
        session.onInvocationStarted('invocation-456');

        expect(session.isReadyForInvocation()).toBe(false);
      });
    });

    describe('executing -> running', () => {
      beforeEach(() => {
        session.onContainerStarted('container-123');
        session.onInvocationStarted('invocation-456');
      });

      it('should transition on invocation completed', () => {
        session.onInvocationCompleted();

        expect(session.status).toBe('running');
        expect(session.invocationId).toBeUndefined();
      });
    });

    describe('executing -> awaiting_input', () => {
      beforeEach(() => {
        session.onContainerStarted('container-123');
        session.onInvocationStarted('invocation-456');
      });

      it('should transition on question received', () => {
        const question = createTestQuestion();
        session.onQuestionReceived(question);

        expect(session.status).toBe('awaiting_input');
        expect(session.pendingQuestion).toEqual(question);
        expect(session.isAwaitingInput()).toBe(true);
      });
    });

    describe('awaiting_input -> running', () => {
      beforeEach(() => {
        session.onContainerStarted('container-123');
        session.onInvocationStarted('invocation-456');
        session.onQuestionReceived(createTestQuestion());
      });

      it('should transition on answer provided', () => {
        session.onAnswerProvided();

        expect(session.status).toBe('running');
        expect(session.pendingQuestion).toBeUndefined();
        expect(session.isAwaitingInput()).toBe(false);
      });
    });

    describe('any -> terminated', () => {
      it('should terminate from created state', () => {
        session.terminate('user_requested');

        expect(session.status).toBe('terminated');
        expect(session.isActive()).toBe(false);
        expect(session.state).toEqual({ status: 'terminated', reason: 'user_requested' });
      });

      it('should terminate from running state', () => {
        session.onContainerStarted('container-123');
        session.terminate('timeout');

        expect(session.status).toBe('terminated');
        expect(session.state).toEqual({ status: 'terminated', reason: 'timeout' });
      });

      it('should terminate from executing state', () => {
        session.onContainerStarted('container-123');
        session.onInvocationStarted('invocation-456');
        session.terminate('container_crashed');

        expect(session.status).toBe('terminated');
      });

      it('should be idempotent when already terminated', () => {
        session.terminate('user_requested');
        session.terminate('timeout'); // Should not throw

        expect(session.status).toBe('terminated');
        expect(session.state).toEqual({ status: 'terminated', reason: 'user_requested' });
      });
    });
  });

  describe('invalid transitions', () => {
    it('should throw when trying to start invocation in created state', () => {
      expect(() => session.onInvocationStarted('invocation-456')).toThrow(
        SessionInvalidStateError
      );
    });

    it('should throw when trying to complete invocation when not executing', () => {
      session.onContainerStarted('container-123');

      expect(() => session.onInvocationCompleted()).toThrow(SessionInvalidStateError);
    });

    it('should throw when trying to provide answer when not awaiting', () => {
      session.onContainerStarted('container-123');

      expect(() => session.onAnswerProvided()).toThrow(SessionInvalidStateError);
    });
  });

  describe('helper methods', () => {
    describe('hasRunningContainer', () => {
      it('should return false in created state', () => {
        expect(session.hasRunningContainer()).toBe(false);
      });

      it('should return true in running state', () => {
        session.onContainerStarted('container-123');
        expect(session.hasRunningContainer()).toBe(true);
      });

      it('should return false in terminated state', () => {
        session.onContainerStarted('container-123');
        session.terminate('user_requested');
        expect(session.hasRunningContainer()).toBe(false);
      });
    });

    describe('getSummary', () => {
      it('should return session summary', () => {
        session.onContainerStarted('container-123');

        const summary = session.getSummary();

        expect(summary.id).toBe(session.id);
        expect(summary.status).toBe('running');
        expect(summary.isActive).toBe(true);
        expect(summary.containerId).toBe('container-123');
        expect(summary.createdAt).toBeInstanceOf(Date);
        expect(summary.lastActiveAt).toBeInstanceOf(Date);
      });
    });

    describe('toJSON', () => {
      it('should export session data', () => {
        session.onContainerStarted('container-123');

        const data = session.toJSON();

        expect(data.id).toBe(session.id);
        expect(data.state).toEqual({ status: 'running', containerId: 'container-123' });
        expect(data.containerConfig).toEqual(createTestConfig());
      });
    });

    describe('update', () => {
      it('should update default options', () => {
        session.update({ defaultOptions: { timeout: 60000, mode: 'test-mode' } });

        expect(session.defaultOptions.timeout).toBe(60000);
        expect(session.defaultOptions.mode).toBe('test-mode');
      });

      it('should update lastActiveAt', () => {
        const before = session.lastActiveAt;

        // Small delay to ensure time difference
        session.update({});

        expect(session.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      });
    });
  });
});
