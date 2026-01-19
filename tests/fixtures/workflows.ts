/**
 * Test Workflow Definitions
 */

import type { WorkflowDefinition } from '../../src/types/WorkflowDefinition.js';

/**
 * Simple two-step workflow for basic testing
 */
export const simpleWorkflow: WorkflowDefinition = {
  name: 'simple-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'step-1',
      type: 'agent',
      config: { command: '/test:start', mode: 'coding' },
      next: 'step-2',
    },
    {
      id: 'step-2',
      type: 'agent',
      config: { command: '/test:complete', mode: 'coding' },
    },
  ],
};

/**
 * Workflow with human review step
 */
export const humanReviewWorkflow: WorkflowDefinition = {
  name: 'human-review-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'specify',
      type: 'agent',
      config: { command: '/speckit:specify', mode: 'research' },
      next: 'review',
    },
    {
      id: 'review',
      type: 'human',
      config: {
        action: 'review',
        urgency: 'blocking_soon',
        prompt: 'Please review the specification',
      },
      next: 'implement',
    },
    {
      id: 'implement',
      type: 'agent',
      config: { command: '/speckit:implement', mode: 'coding' },
    },
  ],
};

/**
 * Workflow with condition branching
 */
export const conditionalWorkflow: WorkflowDefinition = {
  name: 'conditional-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'check',
      type: 'condition',
      config: {
        expression: 'data.approved == true',
        then: 'deploy',
        else: 'revise',
      },
    },
    {
      id: 'deploy',
      type: 'agent',
      config: { command: '/deploy:production', mode: 'coding' },
    },
    {
      id: 'revise',
      type: 'agent',
      config: { command: '/revise:spec', mode: 'coding' },
      next: 'check',
    },
  ],
};

/**
 * Workflow with parallel branches
 */
export const parallelWorkflow: WorkflowDefinition = {
  name: 'parallel-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'parallel-tests',
      type: 'parallel',
      config: {
        branches: [
          [
            { id: 'unit-tests', type: 'agent', config: { command: '/test:unit', mode: 'coding' } },
          ],
          [
            { id: 'integration-tests', type: 'agent', config: { command: '/test:integration', mode: 'coding' } },
          ],
          [
            { id: 'e2e-tests', type: 'agent', config: { command: '/test:e2e', mode: 'coding' } },
          ],
        ],
        join: 'all',
      },
      next: 'deploy',
    },
    {
      id: 'deploy',
      type: 'agent',
      config: { command: '/deploy:staging', mode: 'coding' },
    },
  ],
};

/**
 * Standard development workflow (mirrors the built-in)
 */
export const standardDevelopmentWorkflow: WorkflowDefinition = {
  name: 'standard-development',
  version: '1.0.0',
  steps: [
    {
      id: 'specify',
      type: 'agent',
      config: { command: '/speckit:specify', mode: 'research' },
      next: 'plan',
    },
    {
      id: 'plan',
      type: 'agent',
      config: { command: '/speckit:plan', mode: 'research' },
      next: 'human-review-plan',
    },
    {
      id: 'human-review-plan',
      type: 'human',
      config: {
        action: 'review',
        urgency: 'blocking_soon',
        prompt: 'Please review the implementation plan',
      },
      next: 'implement',
    },
    {
      id: 'implement',
      type: 'agent',
      config: { command: '/speckit:implement', mode: 'coding' },
      next: 'human-review-code',
    },
    {
      id: 'human-review-code',
      type: 'human',
      config: {
        action: 'review',
        urgency: 'when_available',
        prompt: 'Please review the implementation',
      },
    },
  ],
};

/**
 * Workflow with error handling configuration
 */
export const errorHandlingWorkflow: WorkflowDefinition = {
  name: 'error-handling-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'risky-step',
      type: 'agent',
      config: { command: '/risky:operation', mode: 'coding' },
      retries: 3,
      timeout: 30000,
      next: 'success',
    },
    {
      id: 'success',
      type: 'agent',
      config: { command: '/notify:success', mode: 'coding' },
    },
  ],
  onError: {
    onError: (error, step) => {
      if (step.id === 'risky-step') {
        return { type: 'retry', maxAttempts: 3, delay: 1000 };
      }
      return { type: 'abort', reason: error.message };
    },
  },
  timeout: 300000,
};

/**
 * Workflow with conditional next steps
 */
export const conditionalNextWorkflow: WorkflowDefinition = {
  name: 'conditional-next-workflow',
  version: '1.0.0',
  steps: [
    {
      id: 'analyze',
      type: 'agent',
      config: { command: '/analyze:code', mode: 'research' },
      next: [
        { condition: 'outputs.analyze.issues > 10', stepId: 'major-refactor' },
        { condition: 'outputs.analyze.issues > 0', stepId: 'minor-fixes' },
        { condition: 'outputs.analyze.issues == 0', stepId: 'approve' },
      ],
    },
    {
      id: 'major-refactor',
      type: 'agent',
      config: { command: '/refactor:major', mode: 'coding' },
      next: 'analyze',
    },
    {
      id: 'minor-fixes',
      type: 'agent',
      config: { command: '/fix:minor', mode: 'coding' },
      next: 'analyze',
    },
    {
      id: 'approve',
      type: 'agent',
      config: { command: '/approve:code', mode: 'coding' },
    },
  ],
};

/**
 * All test workflows
 */
export const testWorkflows = {
  simple: simpleWorkflow,
  humanReview: humanReviewWorkflow,
  conditional: conditionalWorkflow,
  parallel: parallelWorkflow,
  standardDevelopment: standardDevelopmentWorkflow,
  errorHandling: errorHandlingWorkflow,
  conditionalNext: conditionalNextWorkflow,
};
