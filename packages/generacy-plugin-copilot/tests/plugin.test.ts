/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Plugin initialization and stub behavior tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotPlugin } from '../src/plugin/copilot-plugin.js';

// Mock pino to avoid actual logging
vi.mock('pino', () => ({
  default: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock Octokit
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    issues: {
      get: vi.fn().mockResolvedValue({
        data: {
          id: 123,
          number: 42,
          title: 'Test Issue',
          body: 'Test body',
          state: 'open',
          html_url: 'https://github.com/test/repo/issues/42',
          labels: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          closed_at: null,
        },
      }),
    },
    search: {
      issuesAndPullRequests: vi.fn().mockResolvedValue({
        data: { items: [] },
      }),
    },
    pulls: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      listFiles: vi.fn().mockResolvedValue({ data: [] }),
      listReviews: vi.fn().mockResolvedValue({ data: [] }),
    },
  })),
}));

describe('CopilotPlugin', () => {
  let plugin: CopilotPlugin;
  const validToken = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  beforeEach(() => {
    plugin = new CopilotPlugin({ githubToken: validToken });
  });

  afterEach(async () => {
    await plugin.dispose();
  });

  describe('initialization', () => {
    it('should initialize with valid options', () => {
      expect(plugin).toBeInstanceOf(CopilotPlugin);
    });

    it('should throw on invalid token format', () => {
      expect(() => new CopilotPlugin({ githubToken: '' })).toThrow();
    });

    it('should accept custom API base URL', () => {
      const customPlugin = new CopilotPlugin({
        githubToken: validToken,
        apiBaseUrl: 'https://github.example.com/api/v3',
      });
      expect(customPlugin).toBeInstanceOf(CopilotPlugin);
    });

    it('should accept polling configuration', () => {
      const customPlugin = new CopilotPlugin({
        githubToken: validToken,
        polling: {
          initialIntervalMs: 10000,
          maxIntervalMs: 120000,
          backoffMultiplier: 2,
        },
      });
      expect(customPlugin).toBeInstanceOf(CopilotPlugin);
    });

    it('should accept workspace defaults', () => {
      const customPlugin = new CopilotPlugin({
        githubToken: validToken,
        workspaceDefaults: {
          autoMerge: true,
          reviewRequired: false,
        },
      });
      expect(customPlugin).toBeInstanceOf(CopilotPlugin);
    });
  });

  describe('createWorkspace', () => {
    it('should create a workspace for tracking', async () => {
      const workspace = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
      });

      expect(workspace).toBeDefined();
      expect(workspace.id).toMatch(/^ws_/);
      expect(workspace.issueUrl).toBe('https://github.com/test/repo/issues/42');
      expect(workspace.status).toBe('pending');
      expect(workspace.owner).toBe('test');
      expect(workspace.repo).toBe('repo');
      expect(workspace.issueNumber).toBe(42);
    });

    it('should reject invalid issue URL', async () => {
      await expect(
        plugin.createWorkspace({ issueUrl: 'https://github.com/invalid' })
      ).rejects.toThrow();
    });

    it('should apply workspace options', async () => {
      const workspace = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
        options: {
          autoMerge: true,
          prLabels: ['copilot'],
        },
      });

      expect(workspace).toBeDefined();
      expect(workspace.status).toBe('pending');
    });
  });

  describe('getWorkspace', () => {
    it('should return null for non-existent workspace', async () => {
      const workspace = await plugin.getWorkspace('ws_nonexistent');
      expect(workspace).toBeNull();
    });

    it('should return workspace after creation', async () => {
      const created = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
      });

      const retrieved = await plugin.getWorkspace(created.id);
      expect(retrieved).toEqual(created);
    });
  });

  describe('pollWorkspaceStatus', () => {
    it('should return pending status when no PRs exist', async () => {
      const workspace = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
      });

      const status = await plugin.pollWorkspaceStatus(workspace.id);
      expect(status).toBe('pending');
    });

    it('should throw for non-existent workspace', async () => {
      await expect(plugin.pollWorkspaceStatus('ws_nonexistent')).rejects.toThrow(
        'Workspace not found'
      );
    });
  });

  describe('getChanges', () => {
    it('should throw when workspace not in correct state', async () => {
      const workspace = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
      });

      await expect(plugin.getChanges(workspace.id)).rejects.toThrow('expected state');
    });
  });

  describe('getPullRequest', () => {
    it('should return null when no PR associated', async () => {
      const workspace = await plugin.createWorkspace({
        issueUrl: 'https://github.com/test/repo/issues/42',
      });

      const pr = await plugin.getPullRequest(workspace.id);
      expect(pr).toBeNull();
    });
  });

  describe('dispose', () => {
    it('should dispose the plugin', async () => {
      await plugin.dispose();

      await expect(
        plugin.createWorkspace({ issueUrl: 'https://github.com/test/repo/issues/42' })
      ).rejects.toThrow('disposed');
    });

    it('should be idempotent', async () => {
      await plugin.dispose();
      await plugin.dispose(); // Should not throw
    });
  });
});
