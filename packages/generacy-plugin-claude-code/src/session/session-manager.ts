/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Session manager implementing the registry pattern for sessions.
 */

import type { Logger } from 'pino';
import {
  SessionNotFoundError,
} from '../errors.js';
import type {
  Session as SessionInterface,
  QuestionPayload,
  TerminationReason,
} from '../types.js';
import { Session } from './session.js';
import type {
  CreateSessionOptions,
  SessionSummary,
} from './types.js';
import {
  DEFAULT_SESSION_TIMEOUT_MS,
} from './types.js';

/**
 * SessionManager options.
 */
export interface SessionManagerOptions {
  /** Session timeout in milliseconds */
  sessionTimeoutMs?: number;

  /** Cleanup interval in milliseconds */
  cleanupIntervalMs?: number;

  /** Maximum concurrent sessions */
  maxSessions?: number;
}

/**
 * Session manager implementing the registry pattern.
 * Manages session lifecycle, registration, and cleanup.
 */
export class SessionManager {
  private readonly logger: Logger;
  private readonly sessions: Map<string, Session> = new Map();
  private readonly options: Required<SessionManagerOptions>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(logger: Logger, options: SessionManagerOptions = {}) {
    this.logger = logger.child({ component: 'SessionManager' });
    this.options = {
      sessionTimeoutMs: options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      cleanupIntervalMs: options.cleanupIntervalMs ?? 60000, // 1 minute
      maxSessions: options.maxSessions ?? 100,
    };

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Create a new session.
   */
  create(options: CreateSessionOptions): Session {
    // Check if we've reached max sessions
    if (this.sessions.size >= this.options.maxSessions) {
      this.logger.warn({ count: this.sessions.size }, 'Max sessions reached, attempting cleanup');
      this.cleanupExpiredSessions();

      if (this.sessions.size >= this.options.maxSessions) {
        throw new Error(`Maximum sessions (${this.options.maxSessions}) reached`);
      }
    }

    const session = new Session(options);

    this.sessions.set(session.id, session);

    this.logger.info({ sessionId: session.id }, 'Session created');

    return session;
  }

  /**
   * Get a session by ID.
   * Throws SessionNotFoundError if not found.
   */
  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  /**
   * Get a session by ID, returning undefined if not found.
   */
  find(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get a session's public interface.
   */
  getSession(sessionId: string): SessionInterface {
    return this.get(sessionId);
  }

  /**
   * List all active sessions.
   */
  listActive(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.isActive())
      .map((session) => session.getSummary());
  }

  /**
   * List all sessions.
   */
  listAll(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((session) => session.getSummary());
  }

  /**
   * Get the count of active sessions.
   */
  getActiveCount(): number {
    return Array.from(this.sessions.values())
      .filter((session) => session.isActive())
      .length;
  }

  /**
   * Get total session count.
   */
  getTotalCount(): number {
    return this.sessions.size;
  }

  // ==========================================================================
  // Session state transitions
  // ==========================================================================

  /**
   * Mark a session as having a started container.
   */
  onContainerStarted(sessionId: string, containerId: string): void {
    const session = this.get(sessionId);
    session.onContainerStarted(containerId);
    this.logger.info({ sessionId, containerId }, 'Session container started');
  }

  /**
   * Mark a session as executing an invocation.
   */
  onInvocationStarted(sessionId: string, invocationId: string): void {
    const session = this.get(sessionId);
    session.onInvocationStarted(invocationId);
    this.logger.debug({ sessionId, invocationId }, 'Session invocation started');
  }

  /**
   * Mark a session's invocation as completed.
   */
  onInvocationCompleted(sessionId: string): void {
    const session = this.get(sessionId);
    session.onInvocationCompleted();
    this.logger.debug({ sessionId }, 'Session invocation completed');
  }

  /**
   * Mark a session as awaiting input.
   */
  onQuestionReceived(sessionId: string, question: QuestionPayload): void {
    const session = this.get(sessionId);
    session.onQuestionReceived(question);
    this.logger.info(
      { sessionId, urgency: question.urgency },
      'Session question received'
    );
  }

  /**
   * Mark a session as having received an answer.
   */
  onAnswerProvided(sessionId: string): void {
    const session = this.get(sessionId);
    session.onAnswerProvided();
    this.logger.debug({ sessionId }, 'Session answer provided');
  }

  /**
   * Terminate a session.
   */
  terminate(sessionId: string, reason: TerminationReason): void {
    const session = this.find(sessionId);

    if (!session) {
      this.logger.warn({ sessionId }, 'Session not found for termination');
      return;
    }

    session.terminate(reason);
    this.logger.info({ sessionId, reason }, 'Session terminated');
  }

  // ==========================================================================
  // Session cleanup
  // ==========================================================================

  /**
   * Remove a session from the registry.
   */
  remove(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);

    if (existed) {
      this.logger.info({ sessionId }, 'Session removed');
    }

    return existed;
  }

  /**
   * Clean up expired sessions.
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, session] of this.sessions) {
      const age = now - session.lastActiveAt.getTime();

      // Remove terminated sessions after a short grace period (1 minute)
      if (!session.isActive() && age > 60000) {
        expiredIds.push(id);
        continue;
      }

      // Remove active sessions that have exceeded the timeout
      if (session.isActive() && age > this.options.sessionTimeoutMs) {
        session.terminate('timeout');
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.sessions.delete(id);
    }

    if (expiredIds.length > 0) {
      this.logger.info({ count: expiredIds.length }, 'Cleaned up expired sessions');
    }

    return expiredIds.length;
  }

  /**
   * Clean up all sessions.
   */
  cleanupAll(): void {
    const count = this.sessions.size;

    for (const session of this.sessions.values()) {
      if (session.isActive()) {
        session.terminate('user_requested');
      }
    }

    this.sessions.clear();

    this.logger.info({ count }, 'Cleaned up all sessions');
  }

  /**
   * Stop the cleanup timer.
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Dispose of the session manager.
   */
  dispose(): void {
    this.stopCleanupTimer();
    this.cleanupAll();
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Start the periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.options.cleanupIntervalMs);

    // Don't let the timer prevent the process from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }
}
