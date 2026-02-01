/**
 * Unit tests for HumancyReviewAction
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumancyReviewAction, type HumanDecisionHandler } from './humancy-review.js';
import type { ActionContext, StepDefinition } from '../../types/index.js';
import type { WorkflowStore, WorkflowState } from '../../types/store.js';

// Mock workflow store
const createMockStore = (): WorkflowStore => ({
  save: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(null),
  delete: vi.fn().mockResolvedValue(undefined),
  listPending: vi.fn().mockResolvedValue([]),
});

// Mock human handler
const createMockHumanHandler = (response?: Partial<{
  approved: boolean;
  decision: string;
  input: string;
  respondedBy: string;
  respondedAt: string;
}>): HumanDecisionHandler => ({
  requestDecision: vi.fn().mockResolvedValue({
    approved: response?.approved ?? true,
    decision: response?.decision,
    input: response?.input,
    respondedBy: response?.respondedBy ?? 'test-user',
    respondedAt: response?.respondedAt ?? new Date().toISOString(),
  }),
});

// Create mock context
const createMockContext = (overrides?: Partial<ActionContext>): ActionContext => ({
  workflow: {
    name: 'test-workflow',
    id: 'wf-123',
    version: '1.0',
    phases: [],
    sourceFile: 'test.yaml',
    env: {},
  },
  phase: {
    id: 'test-phase',
    name: 'Test Phase',
    steps: [],
  },
  step: {
    name: 'test-step',
    uses: 'humancy.request_review',
    with: {
      artifact: 'Test artifact content',
      context: 'Please review this',
    },
  },
  inputs: {},
  stepOutputs: new Map(),
  env: {},
  workdir: '/tmp/test',
  signal: new AbortController().signal,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  ...overrides,
});

// Create step definition
const createStep = (overrides?: Partial<StepDefinition>): StepDefinition => ({
  name: 'human-review',
  uses: 'humancy.request_review',
  with: {
    artifact: 'Test artifact content',
    context: 'Please review this test artifact',
    urgency: 'normal',
  },
  ...overrides,
});

describe('HumancyReviewAction', () => {
  let action: HumancyReviewAction;
  let mockStore: WorkflowStore;
  let mockHandler: HumanDecisionHandler;

  beforeEach(() => {
    mockStore = createMockStore();
    mockHandler = createMockHumanHandler();
    action = new HumancyReviewAction(mockHandler, mockStore);
  });

  describe('canHandle', () => {
    it('should handle humancy.request_review steps', () => {
      const step = createStep({ uses: 'humancy.request_review' });
      expect(action.canHandle(step)).toBe(true);
    });

    it('should handle humancy action type', () => {
      const step = createStep({ action: 'humancy.request_review', uses: undefined });
      expect(action.canHandle(step)).toBe(true);
    });

    it('should not handle other action types', () => {
      const step = createStep({ uses: 'agent.invoke' });
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('validate', () => {
    it('should accept valid step with artifact and context', () => {
      const step = createStep();
      const result = action.validate(step);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept step with only artifact', () => {
      const step = createStep({
        with: { artifact: 'Content to review' },
      });
      const result = action.validate(step);
      expect(result.valid).toBe(true);
    });

    it('should accept step with only context', () => {
      const step = createStep({
        with: { context: 'Review context' },
      });
      const result = action.validate(step);
      expect(result.valid).toBe(true);
    });

    it('should reject step without artifact or context', () => {
      const step = createStep({
        with: {},
      });
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('MISSING_REQUIRED_INPUT');
    });

    it('should reject invalid urgency', () => {
      const step = createStep({
        with: {
          artifact: 'content',
          urgency: 'invalid',
        },
      });
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_URGENCY')).toBe(true);
    });

    it('should reject negative timeout', () => {
      const step = createStep({
        with: {
          artifact: 'content',
          timeout: -1000,
        },
      });
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_TIMEOUT')).toBe(true);
    });
  });

  describe('execute', () => {
    it('should execute and return approval result', async () => {
      const step = createStep();
      const context = createMockContext({ step });

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        approved: true,
        respondedBy: 'test-user',
      });
    });

    it('should execute and return rejection result', async () => {
      const rejectHandler = createMockHumanHandler({
        approved: false,
        input: 'Needs more detail',
        respondedBy: 'reviewer',
      });
      const rejectAction = new HumancyReviewAction(rejectHandler, mockStore);

      const step = createStep();
      const context = createMockContext({ step });

      const result = await rejectAction.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        approved: false,
        comments: 'Needs more detail',
      });
    });

    it('should save workflow checkpoint before requesting review', async () => {
      const step = createStep();
      const context = createMockContext({ step });

      await action.execute(step, context);

      expect(mockStore.save).toHaveBeenCalled();
      const savedState = (mockStore.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as WorkflowState;
      expect(savedState.pendingReview).toBeDefined();
      expect(savedState.pendingReview?.artifact).toBe('Test artifact content');
    });

    it('should clear checkpoint on successful completion', async () => {
      const step = createStep();
      const context = createMockContext({ step });

      await action.execute(step, context);

      expect(mockStore.delete).toHaveBeenCalled();
    });

    it('should simulate approval when no handler is configured', async () => {
      const noHandlerAction = new HumancyReviewAction(undefined, mockStore);
      const step = createStep();
      const context = createMockContext({ step });

      const result = await noHandlerAction.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        approved: true,
        respondedBy: 'simulated',
      });
    });

    it('should pass urgency to human handler', async () => {
      const step = createStep({
        with: {
          artifact: 'Urgent review needed',
          context: 'Critical bug fix',
          urgency: 'blocking_now',
        },
      });
      const context = createMockContext({ step });

      await action.execute(step, context);

      expect(mockHandler.requestDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          urgency: 'blocking_now',
        }),
        expect.any(Number)
      );
    });

    it('should use custom timeout when provided', async () => {
      const customTimeout = 60000;
      const step = createStep({
        with: {
          artifact: 'content',
          timeout: customTimeout,
        },
      });
      const context = createMockContext({ step });

      await action.execute(step, context);

      expect(mockHandler.requestDecision).toHaveBeenCalledWith(
        expect.any(Object),
        customTimeout
      );
    });

    it('should handle handler timeout error', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'CorrelationTimeoutError';

      const timeoutHandler: HumanDecisionHandler = {
        requestDecision: vi.fn().mockRejectedValue(timeoutError),
      };
      const timeoutAction = new HumancyReviewAction(timeoutHandler, mockStore);

      const step = createStep();
      const context = createMockContext({ step });

      const result = await timeoutAction.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should handle cancellation', async () => {
      const controller = new AbortController();
      const slowHandler: HumanDecisionHandler = {
        requestDecision: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { approved: true, respondedBy: 'user', respondedAt: new Date().toISOString() };
        }),
      };
      const slowAction = new HumancyReviewAction(slowHandler, mockStore);

      const step = createStep();
      const context = createMockContext({
        step,
        signal: controller.signal,
      });

      // Cancel during execution
      setTimeout(() => controller.abort(), 10);

      const result = await slowAction.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('should include reviewId in output', async () => {
      const step = createStep();
      const context = createMockContext({ step });

      const result = await action.execute(step, context);

      expect(result.output).toHaveProperty('reviewId');
      expect(typeof (result.output as { reviewId: string }).reviewId).toBe('string');
    });
  });

  describe('setHumanHandler', () => {
    it('should allow late binding of handler', async () => {
      const lateAction = new HumancyReviewAction(undefined, mockStore);

      // First, no handler configured
      let step = createStep();
      let context = createMockContext({ step });
      let result = await lateAction.execute(step, context);
      expect((result.output as { respondedBy: string }).respondedBy).toBe('simulated');

      // Set handler
      lateAction.setHumanHandler(mockHandler);

      // Now handler is used
      step = createStep();
      context = createMockContext({ step });
      result = await lateAction.execute(step, context);
      expect((result.output as { respondedBy: string }).respondedBy).toBe('test-user');
    });
  });
});
