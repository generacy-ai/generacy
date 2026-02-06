/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Workspace lifecycle tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceManager } from '../src/workspace/workspace-manager.js';
import { GitHubClient } from '../src/github/client.js';
import { WorkspaceNotFoundError, WorkspaceInvalidStateError } from '../src/errors.js';

// Mock the GitHub client
vi.mock('../src/github/client.js', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getIssue: vi.fn().mockResolvedValue({
      id: 123,
      number: 42,
      title: 'Test Issue',
      body: 'Test body',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/42',
      labels: [],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      closed_at: null,
    }),
    listLinkedPullRequests: vi.fn().mockResolvedValue([]),
    getPullRequest: vi.fn(),
    getPullRequestFiles: vi.fn().mockResolvedValue([]),
    getPullRequestReviews: vi.fn().mockResolvedValue([]),
  })),
  parseIssueUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!match) throw new Error('Invalid URL');
    return { owner: match[1], repo: match[2], issueNumber: parseInt(match[3], 10) };
  }),
}));

describe('WorkspaceManager', () => {
  let manager: WorkspaceManager;
  let mockGitHubClient: GitHubClient;

  beforeEach(() => {
    mockGitHubClient = new GitHubClient({ token: 'test' });
    manager = new WorkspaceManager(mockGitHubClient);
  });

  describe('createWorkspace', () => {
    it('should create a workspace with generated ID', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      expect(workspace.id).toMatch(/^ws_[a-f0-9]{16}$/);
      expect(workspace.issueUrl).toBe('https://github.com/owner/repo/issues/42');
      expect(workspace.status).toBe('pending');
      expect(workspace.owner).toBe('owner');
      expect(workspace.repo).toBe('repo');
      expect(workspace.issueNumber).toBe(42);
      expect(workspace.createdAt).toBeInstanceOf(Date);
      expect(workspace.updatedAt).toBeInstanceOf(Date);
    });

    it('should apply workspace options', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
        options: {
          autoMerge: true,
          reviewRequired: false,
          prLabels: ['automated'],
        },
      });

      expect(workspace).toBeDefined();
    });

    it('should use default options when not provided', async () => {
      const managerWithDefaults = new WorkspaceManager(mockGitHubClient, {
        defaultOptions: {
          autoMerge: false,
          reviewRequired: true,
        },
      });

      const workspace = await managerWithDefaults.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      expect(workspace).toBeDefined();
    });
  });

  describe('getWorkspace', () => {
    it('should return null for non-existent workspace', async () => {
      const result = await manager.getWorkspace('ws_nonexistent');
      expect(result).toBeNull();
    });

    it('should return workspace after creation', async () => {
      const created = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const retrieved = await manager.getWorkspace(created.id);
      expect(retrieved).toEqual(created);
    });
  });

  describe('pollWorkspaceStatus', () => {
    it('should throw WorkspaceNotFoundError for non-existent workspace', async () => {
      await expect(manager.pollWorkspaceStatus('ws_nonexistent')).rejects.toThrow(
        WorkspaceNotFoundError
      );
    });

    it('should return pending when no PRs linked', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const status = await manager.pollWorkspaceStatus(workspace.id);
      expect(status).toBe('pending');
    });

    it('should return review_ready when open PR exists', async () => {
      vi.mocked(mockGitHubClient.listLinkedPullRequests).mockResolvedValueOnce([
        {
          id: 1,
          number: 100,
          title: 'Fix #42',
          body: 'Closes #42',
          state: 'open',
          html_url: 'https://github.com/owner/repo/pulls/100',
          head: { ref: 'fix-42', sha: 'abc' },
          base: { ref: 'main', sha: 'def' },
          merged: false,
          mergeable: true,
          mergeable_state: 'clean',
          additions: 10,
          deletions: 5,
          changed_files: 3,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          merged_at: null,
          closed_at: null,
        },
      ]);

      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const status = await manager.pollWorkspaceStatus(workspace.id);
      expect(status).toBe('review_ready');
    });

    it('should return merged when PR is merged', async () => {
      vi.mocked(mockGitHubClient.listLinkedPullRequests).mockResolvedValueOnce([
        {
          id: 1,
          number: 100,
          title: 'Fix #42',
          body: 'Closes #42',
          state: 'closed',
          html_url: 'https://github.com/owner/repo/pulls/100',
          head: { ref: 'fix-42', sha: 'abc' },
          base: { ref: 'main', sha: 'def' },
          merged: true,
          mergeable: null,
          mergeable_state: 'unknown',
          additions: 10,
          deletions: 5,
          changed_files: 3,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          merged_at: '2024-01-02T00:00:00Z',
          closed_at: '2024-01-02T00:00:00Z',
        },
      ]);

      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const status = await manager.pollWorkspaceStatus(workspace.id);
      expect(status).toBe('merged');
    });
  });

  describe('getChanges', () => {
    it('should throw WorkspaceInvalidStateError when workspace is pending', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      await expect(manager.getChanges(workspace.id)).rejects.toThrow(
        WorkspaceInvalidStateError
      );
    });
  });

  describe('getPullRequest', () => {
    it('should return null when no PR linked', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const pr = await manager.getPullRequest(workspace.id);
      expect(pr).toBeNull();
    });
  });

  describe('deleteWorkspace', () => {
    it('should delete existing workspace', async () => {
      const workspace = await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/42',
      });

      const deleted = manager.deleteWorkspace(workspace.id);
      expect(deleted).toBe(true);

      const retrieved = await manager.getWorkspace(workspace.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent workspace', () => {
      const deleted = manager.deleteWorkspace('ws_nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all workspaces', async () => {
      await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/1',
      });
      await manager.createWorkspace({
        issueUrl: 'https://github.com/owner/repo/issues/2',
      });

      manager.clear();

      const ws1 = await manager.getWorkspace('ws_1');
      const ws2 = await manager.getWorkspace('ws_2');
      expect(ws1).toBeNull();
      expect(ws2).toBeNull();
    });
  });
});
