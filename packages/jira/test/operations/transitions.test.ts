import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransitionOperations, createTransitionOperations } from '../../src/operations/transitions.js';
import { JiraClient } from '../../src/client.js';
import { JiraTransitionError } from '../../src/utils/errors.js';
import transitionsFixture from '../fixtures/transitions.json';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

describe('TransitionOperations', () => {
  let mockClient: {
    v3: {
      issues: {
        getTransitions: ReturnType<typeof vi.fn>;
        doTransition: ReturnType<typeof vi.fn>;
        getIssue: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: TransitionOperations;

  beforeEach(() => {
    mockClient = {
      v3: {
        issues: {
          getTransitions: vi.fn(),
          doTransition: vi.fn(),
          getIssue: vi.fn(),
        },
      },
    };
    operations = createTransitionOperations(mockClient as unknown as JiraClient);
  });

  describe('getTransitions', () => {
    it('should get available transitions for an issue', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      const transitions = await operations.getTransitions('PROJ-123');

      expect(mockClient.v3.issues.getTransitions).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        expand: 'transitions.fields',
      });
      expect(transitions).toHaveLength(3);
      expect(transitions[0]?.name).toBe('Start Progress');
      expect(transitions[1]?.name).toBe('Done');
    });
  });

  describe('transition', () => {
    it('should transition an issue by ID', async () => {
      mockClient.v3.issues.doTransition.mockResolvedValue(undefined);

      await operations.transition('PROJ-123', '11');

      expect(mockClient.v3.issues.doTransition).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        transition: { id: '11' },
      });
    });

    it('should transition with fields', async () => {
      mockClient.v3.issues.doTransition.mockResolvedValue(undefined);

      await operations.transition('PROJ-123', '21', {
        fields: { resolution: { name: 'Done' } },
      });

      expect(mockClient.v3.issues.doTransition).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        transition: { id: '21' },
        fields: { resolution: { name: 'Done' } },
      });
    });

    it('should transition with comment', async () => {
      mockClient.v3.issues.doTransition.mockResolvedValue(undefined);

      await operations.transition('PROJ-123', '11', {
        comment: 'Starting work on this issue',
      });

      expect(mockClient.v3.issues.doTransition).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        transition: { id: '11' },
        update: {
          comment: [
            {
              add: {
                body: expect.objectContaining({
                  version: 1,
                  type: 'doc',
                }),
              },
            },
          ],
        },
      });
    });

    it('should throw JiraTransitionError with available transitions on failure', async () => {
      mockClient.v3.issues.doTransition.mockRejectedValue({ status: 400 });
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      await expect(operations.transition('PROJ-123', '99')).rejects.toThrow(JiraTransitionError);

      try {
        await operations.transition('PROJ-123', '99');
      } catch (error) {
        expect(error).toBeInstanceOf(JiraTransitionError);
        expect((error as JiraTransitionError).availableTransitions).toHaveLength(3);
      }
    });
  });

  describe('transitionToStatus', () => {
    it('should find and execute transition to target status', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);
      mockClient.v3.issues.doTransition.mockResolvedValue(undefined);

      await operations.transitionToStatus('PROJ-123', 'In Progress');

      expect(mockClient.v3.issues.doTransition).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        transition: { id: '11' },
      });
    });

    it('should match status name case-insensitively', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);
      mockClient.v3.issues.doTransition.mockResolvedValue(undefined);

      await operations.transitionToStatus('PROJ-123', 'in progress');

      expect(mockClient.v3.issues.doTransition).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        transition: { id: '11' },
      });
    });

    it('should throw JiraTransitionError when no transition to target status', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      await expect(
        operations.transitionToStatus('PROJ-123', 'Non-existent Status')
      ).rejects.toThrow(JiraTransitionError);
    });
  });

  describe('getStatus', () => {
    it('should get current status of an issue', async () => {
      mockClient.v3.issues.getIssue.mockResolvedValue({
        fields: {
          status: {
            id: '3',
            name: 'In Progress',
            statusCategory: {
              id: 4,
              key: 'indeterminate',
              name: 'In Progress',
              colorName: 'yellow',
            },
          },
        },
      });

      const status = await operations.getStatus('PROJ-123');

      expect(mockClient.v3.issues.getIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: ['status'],
      });
      expect(status.name).toBe('In Progress');
    });
  });

  describe('isTransitionAvailable', () => {
    it('should return true when transition is available by name', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      const available = await operations.isTransitionAvailable('PROJ-123', 'Start Progress');

      expect(available).toBe(true);
    });

    it('should return true when transition is available by target status', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      const available = await operations.isTransitionAvailable('PROJ-123', 'Done');

      expect(available).toBe(true);
    });

    it('should return false when transition is not available', async () => {
      mockClient.v3.issues.getTransitions.mockResolvedValue(transitionsFixture);

      const available = await operations.isTransitionAvailable('PROJ-123', 'Non-existent');

      expect(available).toBe(false);
    });
  });
});
