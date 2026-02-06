import { describe, it, expect, vi, beforeEach } from 'vitest';
import { triggerWorkflow, triggerWorkflowDispatch, getWorkflowId } from '../../src/operations/workflows.js';
import { GitHubClient } from '../../src/client.js';
import { WorkflowNotFoundError } from '../../src/utils/errors.js';

// Mock the client
vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

describe('workflows operations', () => {
  let mockClient: GitHubClient;

  const mockWorkflowRun = {
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: 'abc123def456',
    status: 'queued',
    conclusion: null,
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    run_started_at: null,
    actor: {
      id: 1,
      login: 'test-user',
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      type: 'User',
    },
    event: 'workflow_dispatch',
    run_attempt: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      getOwner: vi.fn().mockReturnValue('test-owner'),
      getRepo: vi.fn().mockReturnValue('test-repo'),
      request: vi.fn(),
      requestRaw: vi.fn(),
    } as unknown as GitHubClient;
  });

  describe('triggerWorkflow', () => {
    it('should trigger a workflow and return the run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // createWorkflowDispatch
        .mockResolvedValueOnce({ workflow_runs: [mockWorkflowRun] }); // listWorkflowRuns

      const result = await triggerWorkflow(mockClient, {
        workflow: 'ci.yml',
        ref: 'main',
        inputs: { deploy: 'true' },
      });

      expect(result.id).toBe(123);
      expect(result.name).toBe('CI');
      expect(result.status).toBe('queued');
    });

    it('should use default ref if not provided', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ workflow_runs: [mockWorkflowRun] });

      await triggerWorkflow(mockClient, {
        workflow: 'ci.yml',
      });

      expect(mockClient.request).toHaveBeenCalled();
    });

    it('should throw WorkflowNotFoundError if no runs found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ workflow_runs: [] });

      await expect(
        triggerWorkflow(mockClient, { workflow: 'nonexistent.yml' })
      ).rejects.toThrow(WorkflowNotFoundError);
    });

    it('should throw WorkflowNotFoundError on Not Found error', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(
        triggerWorkflow(mockClient, { workflow: 'nonexistent.yml' })
      ).rejects.toThrow(WorkflowNotFoundError);
    });
  });

  describe('triggerWorkflowDispatch', () => {
    it('should call triggerWorkflow with correct params', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ workflow_runs: [mockWorkflowRun] });

      const result = await triggerWorkflowDispatch(
        mockClient,
        'ci.yml',
        'develop',
        { env: 'prod' }
      );

      expect(result.id).toBe(123);
    });
  });

  describe('getWorkflowId', () => {
    it('should return workflow ID by filename', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflows: [
          { id: 456, path: '.github/workflows/ci.yml', name: 'CI' },
          { id: 789, path: '.github/workflows/deploy.yml', name: 'Deploy' },
        ],
      });

      const id = await getWorkflowId(mockClient, 'ci.yml');

      expect(id).toBe(456);
    });

    it('should return workflow ID by name', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflows: [
          { id: 456, path: '.github/workflows/ci.yml', name: 'CI' },
        ],
      });

      const id = await getWorkflowId(mockClient, 'CI');

      expect(id).toBe(456);
    });

    it('should throw WorkflowNotFoundError if workflow not found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflows: [],
      });

      await expect(getWorkflowId(mockClient, 'nonexistent.yml')).rejects.toThrow(
        WorkflowNotFoundError
      );
    });
  });
});
