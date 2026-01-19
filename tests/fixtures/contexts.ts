/**
 * Test Workflow Contexts
 */

import type { WorkflowContext, WorkflowInput } from '../../src/types/WorkflowContext.js';
import { createWorkflowContext } from '../../src/types/WorkflowContext.js';

/**
 * Empty context for basic testing
 */
export const emptyContext: WorkflowContext = createWorkflowContext();

/**
 * Context with initial input
 */
export const contextWithInput: WorkflowContext = createWorkflowContext({
  input: {
    issueNumber: 42,
    issueTitle: 'Implement new feature',
    repository: 'owner/repo',
  },
  metadata: {
    initiator: 'github-action',
    correlationId: 'ci-run-12345',
  },
});

/**
 * Context with approval data
 */
export const approvedContext: WorkflowContext = {
  input: {},
  outputs: {},
  data: {
    approved: true,
    reviewer: 'admin',
    reviewedAt: '2024-01-15T10:30:00Z',
  },
  metadata: {},
};

/**
 * Context with rejection data
 */
export const rejectedContext: WorkflowContext = {
  input: {},
  outputs: {},
  data: {
    approved: false,
    reviewer: 'admin',
    feedback: 'Needs more documentation',
    reviewedAt: '2024-01-15T10:30:00Z',
  },
  metadata: {},
};

/**
 * Context with step outputs
 */
export const contextWithOutputs: WorkflowContext = {
  input: { feature: 'dark-mode' },
  outputs: {
    'specify': {
      specPath: '/specs/dark-mode/spec.md',
      sections: ['overview', 'requirements', 'acceptance-criteria'],
    },
    'plan': {
      planPath: '/specs/dark-mode/plan.md',
      phases: ['setup', 'implementation', 'testing'],
      estimatedTasks: 15,
    },
  },
  data: {
    currentPhase: 'implementation',
    completedTasks: 8,
  },
  metadata: {
    initiator: 'user',
    correlationId: 'session-abc123',
  },
};

/**
 * Context with nested data for condition testing
 */
export const nestedDataContext: WorkflowContext = {
  input: {},
  outputs: {},
  data: {
    analysis: {
      issues: 5,
      warnings: 12,
      suggestions: 3,
    },
    metrics: {
      coverage: 85.5,
      complexity: 12,
      loc: 1500,
    },
    status: 'review-needed',
  },
  metadata: {},
};

/**
 * Context with array data
 */
export const arrayDataContext: WorkflowContext = {
  input: {},
  outputs: {},
  data: {
    items: ['task-1', 'task-2', 'task-3'],
    results: [
      { id: 'test-1', passed: true },
      { id: 'test-2', passed: false },
      { id: 'test-3', passed: true },
    ],
  },
  metadata: {},
};

/**
 * Create a test input for workflow
 */
export function createTestInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    input: {
      testId: 'test-' + Date.now(),
      ...overrides.input,
    },
    metadata: {
      initiator: 'test-runner',
      correlationId: 'test-' + Date.now(),
      ...overrides.metadata,
    },
  };
}

/**
 * Create a context with specific data for condition testing
 */
export function createConditionContext(data: Record<string, unknown>): WorkflowContext {
  return {
    input: {},
    outputs: {},
    data,
    metadata: {},
  };
}

/**
 * All test contexts
 */
export const testContexts = {
  empty: emptyContext,
  withInput: contextWithInput,
  approved: approvedContext,
  rejected: rejectedContext,
  withOutputs: contextWithOutputs,
  nestedData: nestedDataContext,
  arrayData: arrayDataContext,
};
