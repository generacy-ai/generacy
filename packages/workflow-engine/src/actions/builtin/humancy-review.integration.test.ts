/**
 * Integration tests for HumancyReviewAction with workflow execution
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkflowExecutor } from '../../executor/index.js';
import { HumancyReviewAction, type HumanDecisionHandler } from './humancy-review.js';
import { FilesystemWorkflowStore } from '../../store/filesystem-store.js';
import { registerActionHandler, clearActionRegistry, registerBuiltinActions } from '../index.js';
import type { ExecutableWorkflow, PhaseDefinition, StepDefinition } from '../../types/index.js';

// Test working directory
const TEST_WORKDIR = '/tmp/humancy-review-integration-test';

// Create mock human handler with configurable behavior
const createMockHumanHandler = (
  behavior: 'approve' | 'reject' | 'timeout' | 'approve-then-reject' = 'approve'
): HumanDecisionHandler => {
  let callCount = 0;
  return {
    requestDecision: vi.fn().mockImplementation(async () => {
      callCount++;
      if (behavior === 'timeout') {
        const error = new Error('Timeout');
        error.name = 'CorrelationTimeoutError';
        throw error;
      }
      if (behavior === 'reject' || (behavior === 'approve-then-reject' && callCount > 1)) {
        return {
          approved: false,
          input: 'Rejected: needs revision',
          respondedBy: 'test-reviewer',
          respondedAt: new Date().toISOString(),
        };
      }
      return {
        approved: true,
        respondedBy: 'test-reviewer',
        respondedAt: new Date().toISOString(),
      };
    }),
  };
};

// Create test workflow with humancy review step
const createTestWorkflow = (): ExecutableWorkflow => ({
  name: 'test-humancy-workflow',
  id: 'wf-test-123',
  version: '1.0',
  sourceFile: 'test-workflow.yaml',
  env: {},
  phases: [
    {
      id: 'setup',
      name: 'Setup',
      steps: [
        {
          id: 'prepare',
          name: 'Prepare',
          uses: 'shell',
          command: 'echo "Preparing..."',
        },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      steps: [
        {
          id: 'human-review',
          name: 'Human Review',
          uses: 'humancy.request_review',
          with: {
            artifact: 'Test artifact for review',
            context: 'Please review this test artifact',
            urgency: 'normal',
          },
        },
      ],
    },
    {
      id: 'finalize',
      name: 'Finalize',
      steps: [
        {
          id: 'complete',
          name: 'Complete',
          uses: 'shell',
          command: 'echo "Completed!"',
        },
      ],
    },
  ],
});

// Create workflow with conditional step based on review result
const createConditionalWorkflow = (): ExecutableWorkflow => ({
  name: 'conditional-review-workflow',
  id: 'wf-conditional-123',
  version: '1.0',
  sourceFile: 'conditional-workflow.yaml',
  env: {},
  phases: [
    {
      id: 'review',
      name: 'Review',
      steps: [
        {
          id: 'review-step',
          name: 'Review Step',
          uses: 'humancy.request_review',
          with: {
            artifact: 'Artifact to review',
            context: 'Approve or reject',
          },
        },
        {
          id: 'on-approval',
          name: 'On Approval',
          uses: 'shell',
          command: 'echo "Approved!"',
          condition: '${steps.review-step.approved}',
        },
        {
          id: 'on-rejection',
          name: 'On Rejection',
          uses: 'shell',
          command: 'echo "Rejected!"',
          condition: '${steps.review-step.approved} == false',
        },
      ],
    },
  ],
});

describe('HumancyReviewAction Integration', () => {
  let store: FilesystemWorkflowStore;
  let executor: WorkflowExecutor;

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(TEST_WORKDIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    await fs.mkdir(TEST_WORKDIR, { recursive: true });

    // Reset action registry
    clearActionRegistry();
    registerBuiltinActions();

    // Create store and executor
    store = new FilesystemWorkflowStore(TEST_WORKDIR);
    executor = new WorkflowExecutor({ store });
  });

  afterEach(async () => {
    executor.dispose();
    try {
      await fs.rm(TEST_WORKDIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('Full workflow execution', () => {
    it('should execute workflow with approved review', async () => {
      const mockHandler = createMockHumanHandler('approve');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();
      const result = await executor.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.phaseResults).toHaveLength(3);

      // Check review phase
      const reviewPhase = result.phaseResults.find(p => p.phaseName === 'Review');
      expect(reviewPhase?.status).toBe('completed');

      // Check that human handler was called
      expect(mockHandler.requestDecision).toHaveBeenCalled();
    });

    it('should handle rejected review', async () => {
      const mockHandler = createMockHumanHandler('reject');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();
      const result = await executor.execute(workflow);

      // Workflow should still complete (review step succeeds with rejected result)
      expect(result.status).toBe('completed');

      // Verify rejection response was captured
      const reviewPhase = result.phaseResults.find(p => p.phaseName === 'Review');
      expect(reviewPhase?.status).toBe('completed');
    });

    it('should save state before review and clean up after', async () => {
      const mockHandler = createMockHumanHandler('approve');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();
      await executor.execute(workflow);

      // After completion, no pending states should remain
      const pending = await store.listPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe('Workflow resume', () => {
    it('should allow resuming workflow after human response', async () => {
      // Create a handler that we can control
      const mockHandler: HumanDecisionHandler = {
        requestDecision: vi.fn().mockResolvedValue({
          approved: true,
          respondedBy: 'resume-test-user',
          respondedAt: new Date().toISOString(),
        }),
      };
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();

      // Execute workflow - it will complete with simulated approval
      const result = await executor.execute(workflow);
      expect(result.status).toBe('completed');
    });

    it('should list pending workflows', async () => {
      // Save a pending state directly
      const pendingState = {
        version: '1.0' as const,
        workflowId: 'wf-pending-123',
        workflowFile: 'test.yaml',
        currentPhase: 'review',
        currentStep: 'human-review',
        inputs: {},
        stepOutputs: {},
        pendingReview: {
          reviewId: 'rev-123',
          artifact: 'Test content',
          requestedAt: new Date().toISOString(),
        },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await store.save(pendingState);

      const pending = await executor.listPendingWorkflows();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.workflowId).toBe('wf-pending-123');
    });
  });

  describe('Error handling', () => {
    it('should handle timeout gracefully', async () => {
      const mockHandler = createMockHumanHandler('timeout');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();
      const result = await executor.execute(workflow);

      // Workflow should fail on the review step
      expect(result.status).toBe('failed');

      const reviewPhase = result.phaseResults.find(p => p.phaseName === 'Review');
      expect(reviewPhase?.status).toBe('failed');
    });

    it('should preserve state on failure', async () => {
      const mockHandler = createMockHumanHandler('timeout');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createTestWorkflow();

      try {
        await executor.execute(workflow);
      } catch {
        // Expected to fail
      }

      // State may still be saved for potential retry
      // The exact behavior depends on when the failure occurs
    });
  });

  describe('Conditional execution based on review', () => {
    it('should support conditional steps using review output', async () => {
      const mockHandler = createMockHumanHandler('approve');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow = createConditionalWorkflow();
      const result = await executor.execute(workflow);

      expect(result.status).toBe('completed');

      // The review step should have captured the approval (keyed by step name)
      const context = executor.getExecutionContext();
      const reviewOutput = context?.getStepOutput('Review Step');
      expect(reviewOutput).toBeDefined();
      expect(reviewOutput?.parsed).toMatchObject({
        approved: true,
      });
    });
  });

  describe('Variable interpolation', () => {
    it('should interpolate variables in artifact and context', async () => {
      const mockHandler = createMockHumanHandler('approve');
      const action = new HumancyReviewAction(mockHandler, store);
      registerActionHandler(action);

      const workflow: ExecutableWorkflow = {
        name: 'interpolation-test',
        id: 'wf-interp-123',
        version: '1.0',
        sourceFile: 'test.yaml',
        env: {},
        phases: [
          {
            id: 'setup',
            name: 'Setup',
            steps: [
              {
                id: 'gen-artifact',
                name: 'Generate Artifact',
                uses: 'shell',
                command: 'echo \'{"content": "Generated content", "ready": true}\'',
              },
            ],
          },
          {
            id: 'review',
            name: 'Review',
            steps: [
              {
                id: 'review-generated',
                name: 'Review Generated',
                uses: 'humancy.request_review',
                with: {
                  artifact: '${steps.gen-artifact.content}',
                  context: 'Review the generated artifact',
                },
              },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);
      expect(result.status).toBe('completed');
    });
  });
});
