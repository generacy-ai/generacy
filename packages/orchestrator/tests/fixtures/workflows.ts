import type {
  CreateWorkflowRequest,
  WorkflowResponse,
  WorkflowStatus,
  DecisionQueueItem,
  DecisionType,
  DecisionPriority,
} from '../../src/types/index.js';

/**
 * Sample workflow creation requests
 */
export const sampleWorkflowRequests: CreateWorkflowRequest[] = [
  {
    context: {
      projectId: 'project-123',
      repository: 'user/repo',
      branch: 'main',
    },
    metadata: {
      name: 'Code Review Workflow',
      tags: ['code-review', 'automated'],
    },
  },
  {
    context: {
      issueId: 'issue-456',
      assignee: 'developer@example.com',
    },
    metadata: {
      name: 'Bug Fix Workflow',
      tags: ['bug-fix', 'priority-high'],
    },
  },
  {
    definitionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    context: {
      type: 'deployment',
      environment: 'staging',
    },
    metadata: {
      name: 'Deployment Workflow',
      tags: ['deployment', 'staging'],
    },
  },
];

/**
 * Create a sample workflow response
 */
export function createSampleWorkflowResponse(
  overrides: Partial<WorkflowResponse> = {}
): WorkflowResponse {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    status: 'created',
    currentStep: null,
    context: { projectId: 'project-123' },
    metadata: {
      name: 'Test Workflow',
      tags: ['test'],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create multiple workflow responses with different statuses
 */
export function createWorkflowsWithStatuses(): WorkflowResponse[] {
  const statuses: WorkflowStatus[] = [
    'created',
    'running',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ];

  return statuses.map((status, index) =>
    createSampleWorkflowResponse({
      id: `workflow-${index}`,
      status,
      currentStep: status === 'running' ? `step-${index}` : null,
      metadata: {
        name: `Workflow ${index}`,
        tags: [status],
      },
    })
  );
}

/**
 * Sample decision queue items
 */
export const sampleDecisionQueueItems: DecisionQueueItem[] = [
  {
    id: 'decision-001',
    workflowId: 'workflow-001',
    stepId: 'code-review',
    type: 'approval',
    prompt: 'Do you approve this code change?',
    context: {
      diff: '+console.log("hello")',
      file: 'src/index.ts',
    },
    priority: 'blocking_now',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'decision-002',
    workflowId: 'workflow-001',
    stepId: 'deployment-choice',
    type: 'choice',
    prompt: 'Select deployment target',
    options: [
      { id: 'staging', label: 'Staging', description: 'Deploy to staging environment' },
      { id: 'production', label: 'Production', description: 'Deploy to production' },
    ],
    context: {},
    priority: 'blocking_soon',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'decision-003',
    workflowId: 'workflow-002',
    stepId: 'commit-message',
    type: 'input',
    prompt: 'Enter a commit message for the changes',
    context: {
      suggestedMessage: 'fix: resolve bug #123',
    },
    priority: 'when_available',
    createdAt: new Date().toISOString(),
  },
];

/**
 * Create a sample decision queue item
 */
export function createSampleDecision(
  overrides: Partial<DecisionQueueItem> = {}
): DecisionQueueItem {
  return {
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    stepId: 'test-step',
    type: 'approval',
    prompt: 'Test decision prompt',
    context: {},
    priority: 'when_available',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create decisions with different priorities
 */
export function createDecisionsWithPriorities(): DecisionQueueItem[] {
  const priorities: DecisionPriority[] = [
    'blocking_now',
    'blocking_now',
    'blocking_soon',
    'when_available',
    'when_available',
    'when_available',
  ];

  return priorities.map((priority, index) =>
    createSampleDecision({
      id: `decision-${index}`,
      priority,
      prompt: `Decision ${index} (${priority})`,
    })
  );
}

/**
 * Create decisions with different types
 */
export function createDecisionsWithTypes(): DecisionQueueItem[] {
  const types: DecisionType[] = ['approval', 'choice', 'input', 'review'];

  return types.map((type, index) => {
    const base = createSampleDecision({
      id: `decision-${type}`,
      type,
      prompt: `${type} decision`,
    });

    // Add options for choice type
    if (type === 'choice') {
      base.options = [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ];
    }

    return base;
  });
}
