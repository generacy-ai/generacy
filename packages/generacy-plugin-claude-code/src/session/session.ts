/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Session class implementing a finite state machine for session lifecycle.
 */

import { randomUUID } from 'crypto';
import {
  SessionInvalidStateError,
} from '../errors.js';
import type {
  Session as SessionInterface,
  SessionState,
  SessionStatus,
  InvokeOptions,
  ContainerConfig,
  QuestionPayload,
  TerminationReason,
} from '../types.js';
import type {
  SessionData,
  SessionEvent,
  CreateSessionOptions,
  UpdateSessionOptions,
  SessionSummary,
} from './types.js';
import {
  isValidTransition,
  DEFAULT_INVOKE_OPTIONS,
} from './types.js';

/**
 * Session class implementing a finite state machine.
 * Manages session lifecycle with validated state transitions.
 */
export class Session implements SessionInterface {
  private data: SessionData;

  constructor(options: CreateSessionOptions) {
    const now = new Date();

    this.data = {
      id: randomUUID(),
      state: { status: 'created' },
      containerConfig: options.containerConfig,
      defaultOptions: options.defaultOptions ?? { ...DEFAULT_INVOKE_OPTIONS },
      createdAt: now,
      lastActiveAt: now,
    };
  }

  /**
   * Create a session with a specific ID (for testing or restoration).
   */
  static withId(id: string, options: CreateSessionOptions): Session {
    const session = new Session(options);
    session.data.id = id;
    return session;
  }

  // ==========================================================================
  // SessionInterface implementation (readonly properties)
  // ==========================================================================

  get id(): string {
    return this.data.id;
  }

  get status(): SessionStatus {
    return this.data.state.status;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  get lastActiveAt(): Date {
    return this.data.lastActiveAt;
  }

  // ==========================================================================
  // Internal state accessors
  // ==========================================================================

  get state(): SessionState {
    return this.data.state;
  }

  get containerConfig(): ContainerConfig {
    return this.data.containerConfig;
  }

  get containerId(): string | undefined {
    return this.data.containerId;
  }

  get invocationId(): string | undefined {
    return this.data.invocationId;
  }

  get defaultOptions(): InvokeOptions {
    return this.data.defaultOptions;
  }

  get pendingQuestion(): QuestionPayload | undefined {
    return this.data.pendingQuestion;
  }

  // ==========================================================================
  // State machine transitions
  // ==========================================================================

  /**
   * Process an event and transition to a new state.
   * Throws SessionInvalidStateError if the transition is invalid.
   */
  processEvent(event: SessionEvent): void {
    const newState = this.computeNextState(event);

    if (!isValidTransition(this.status, newState.status)) {
      throw new SessionInvalidStateError(
        this.id,
        this.status,
        [newState.status],
        `process event ${event.type}`
      );
    }

    this.data.state = newState;
    this.data.lastActiveAt = new Date();

    // Update auxiliary data based on event
    this.updateFromEvent(event);
  }

  /**
   * Transition to running state when container starts.
   */
  onContainerStarted(containerId: string): void {
    this.processEvent({ type: 'CONTAINER_STARTED', containerId });
  }

  /**
   * Transition to executing state when invocation starts.
   */
  onInvocationStarted(invocationId: string): void {
    this.processEvent({ type: 'INVOCATION_STARTED', invocationId });
  }

  /**
   * Transition back to running state when invocation completes.
   */
  onInvocationCompleted(): void {
    this.processEvent({ type: 'INVOCATION_COMPLETED' });
  }

  /**
   * Transition to awaiting_input state when a question is received.
   */
  onQuestionReceived(question: QuestionPayload): void {
    this.processEvent({ type: 'QUESTION_RECEIVED', question });
  }

  /**
   * Transition back from awaiting_input when answer is provided.
   */
  onAnswerProvided(): void {
    this.processEvent({ type: 'ANSWER_PROVIDED' });
  }

  /**
   * Transition to terminated state.
   */
  terminate(reason: TerminationReason): void {
    // Allow termination from any non-terminated state
    if (this.status === 'terminated') {
      return; // Already terminated
    }

    this.data.state = { status: 'terminated', reason };
    this.data.lastActiveAt = new Date();
  }

  // ==========================================================================
  // Helper methods
  // ==========================================================================

  /**
   * Update session data (partial update).
   */
  update(options: UpdateSessionOptions): void {
    if (options.containerId !== undefined) {
      this.data.containerId = options.containerId;
    }
    if (options.invocationId !== undefined) {
      this.data.invocationId = options.invocationId;
    }
    if (options.pendingQuestion !== undefined) {
      this.data.pendingQuestion = options.pendingQuestion ?? undefined;
    }
    if (options.defaultOptions !== undefined) {
      this.data.defaultOptions = { ...this.data.defaultOptions, ...options.defaultOptions };
    }
    this.data.lastActiveAt = new Date();
  }

  /**
   * Check if the session is in an active (non-terminated) state.
   */
  isActive(): boolean {
    return this.status !== 'terminated';
  }

  /**
   * Check if the session is ready to execute an invocation.
   */
  isReadyForInvocation(): boolean {
    return this.status === 'running';
  }

  /**
   * Check if the session is waiting for human input.
   */
  isAwaitingInput(): boolean {
    return this.status === 'awaiting_input';
  }

  /**
   * Check if the session has a running container.
   */
  hasRunningContainer(): boolean {
    return ['running', 'executing', 'awaiting_input'].includes(this.status) &&
           this.data.containerId !== undefined;
  }

  /**
   * Get a summary of the session for external visibility.
   */
  getSummary(): SessionSummary {
    return {
      id: this.id,
      status: this.status,
      isActive: this.isActive(),
      containerId: this.containerId,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /**
   * Export session data (for serialization).
   */
  toJSON(): SessionData {
    return { ...this.data };
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Compute the next state based on the event.
   */
  private computeNextState(event: SessionEvent): SessionState {
    switch (event.type) {
      case 'CONTAINER_STARTED':
        return { status: 'running', containerId: event.containerId };

      case 'INVOCATION_STARTED':
        if (this.status === 'running' || this.status === 'awaiting_input') {
          return {
            status: 'executing',
            invocationId: event.invocationId,
            containerId: this.getContainerIdOrThrow(),
          };
        }
        return this.data.state;

      case 'INVOCATION_COMPLETED':
        if (this.status === 'executing') {
          return { status: 'running', containerId: this.getContainerIdOrThrow() };
        }
        return this.data.state;

      case 'QUESTION_RECEIVED':
        if (this.status === 'executing' || this.status === 'running') {
          return {
            status: 'awaiting_input',
            question: event.question,
            containerId: this.getContainerIdOrThrow(),
          };
        }
        return this.data.state;

      case 'ANSWER_PROVIDED':
        if (this.status === 'awaiting_input') {
          return { status: 'running', containerId: this.getContainerIdOrThrow() };
        }
        return this.data.state;

      case 'SESSION_ENDED':
        return { status: 'terminated', reason: event.reason };
    }
  }

  /**
   * Update auxiliary data based on event.
   */
  private updateFromEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'CONTAINER_STARTED':
        this.data.containerId = event.containerId;
        break;

      case 'INVOCATION_STARTED':
        this.data.invocationId = event.invocationId;
        break;

      case 'INVOCATION_COMPLETED':
        this.data.invocationId = undefined;
        break;

      case 'QUESTION_RECEIVED':
        this.data.pendingQuestion = event.question;
        break;

      case 'ANSWER_PROVIDED':
        this.data.pendingQuestion = undefined;
        break;

      case 'SESSION_ENDED':
        // No auxiliary data updates needed
        break;
    }
  }

  /**
   * Get container ID or throw if not available.
   */
  private getContainerIdOrThrow(): string {
    const containerId = this.data.containerId;
    if (!containerId) {
      throw new SessionInvalidStateError(
        this.id,
        this.status,
        ['running'],
        'access container ID'
      );
    }
    return containerId;
  }
}
