import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GitHubActionsPlugin,
  createGitHubActionsPlugin,
  PLUGIN_MANIFEST,
} from '../src/plugin.js';
import { SimpleEventBus } from '../src/events/types.js';
import type { GitHubActionsConfig } from '../src/types/config.js';

// Mock dependencies
vi.mock('../src/client.js', () => ({
  createClient: vi.fn().mockReturnValue({
    getOwner: () => 'test-owner',
    getRepo: () => 'test-repo',
    request: vi.fn(),
    requestRaw: vi.fn(),
  }),
  GitHubClient: vi.fn(),
}));

vi.mock('../src/operations/workflows.js', () => ({
  triggerWorkflow: vi.fn().mockResolvedValue({ id: 123, status: 'queued' }),
  triggerWorkflowDispatch: vi.fn().mockResolvedValue({ id: 123 }),
  getWorkflowId: vi.fn().mockResolvedValue(456),
}));

vi.mock('../src/operations/runs.js', () => ({
  getWorkflowRun: vi.fn().mockResolvedValue({ id: 123, status: 'completed', conclusion: 'success' }),
  listWorkflowRuns: vi.fn().mockResolvedValue([]),
  cancelWorkflowRun: vi.fn().mockResolvedValue(undefined),
  rerunWorkflowRun: vi.fn().mockResolvedValue({ id: 123 }),
  rerunFailedJobs: vi.fn().mockResolvedValue({ id: 123 }),
}));

vi.mock('../src/operations/jobs.js', () => ({
  getJobs: vi.fn().mockResolvedValue([]),
  getJob: vi.fn().mockResolvedValue({ id: 456 }),
  getJobLogs: vi.fn().mockResolvedValue('logs'),
  getFailedJobs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/operations/artifacts.js', () => ({
  listArtifacts: vi.fn().mockResolvedValue([]),
  getArtifact: vi.fn().mockResolvedValue({ id: 789 }),
  downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('data')),
  deleteArtifact: vi.fn().mockResolvedValue(undefined),
  listRepoArtifacts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/operations/check-runs.js', () => ({
  createCheckRun: vi.fn().mockResolvedValue({ id: 1001, status: 'queued' }),
  updateCheckRun: vi.fn().mockResolvedValue({ id: 1001, status: 'completed', conclusion: 'success' }),
  getCheckRun: vi.fn().mockResolvedValue({ id: 1001 }),
  listCheckRuns: vi.fn().mockResolvedValue([]),
  listCheckRunsForSuite: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/polling/status-poller.js', () => ({
  createStatusPoller: vi.fn().mockReturnValue({
    poll: vi.fn().mockResolvedValue({ completed: true, run: { id: 123 }, attempts: 1 }),
    start: vi.fn().mockReturnValue({
      promise: Promise.resolve({ completed: true }),
      cancel: vi.fn(),
      isActive: vi.fn().mockReturnValue(false),
    }),
  }),
  pollUntilComplete: vi.fn().mockResolvedValue({ id: 123, status: 'completed' }),
  waitForRun: vi.fn().mockResolvedValue({ completed: true, run: { id: 123 } }),
  StatusPoller: vi.fn(),
}));

describe('GitHubActionsPlugin', () => {
  let config: GitHubActionsConfig;
  let eventBus: SimpleEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      owner: 'test-owner',
      repo: 'test-repo',
      token: 'ghp_test_token',
      workflows: {
        ci: 'ci.yml',
        deploy: 'deploy.yml',
        test: 'test.yml',
      },
    };
    eventBus = new SimpleEventBus();
  });

  describe('constructor', () => {
    it('should create a plugin with valid config', () => {
      const plugin = new GitHubActionsPlugin(config);
      expect(plugin).toBeInstanceOf(GitHubActionsPlugin);
    });

    it('should create a plugin with EventBus', () => {
      const plugin = new GitHubActionsPlugin(config, eventBus);
      expect(plugin).toBeInstanceOf(GitHubActionsPlugin);
    });
  });

  describe('workflow operations', () => {
    it('should trigger a workflow', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const result = await plugin.triggerWorkflow({ workflow: 'ci.yml' });
      expect(result.id).toBe(123);
    });

    it('should trigger workflow dispatch', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.triggerWorkflowDispatch('ci.yml', 'main', { env: 'prod' });
    });

    it('should get workflow ID', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const id = await plugin.getWorkflowId('ci.yml');
      expect(id).toBe(456);
    });
  });

  describe('run operations', () => {
    it('should get workflow run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const run = await plugin.getWorkflowRun(123);
      expect(run.id).toBe(123);
    });

    it('should list workflow runs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.listWorkflowRuns('ci.yml');
    });

    it('should cancel workflow run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.cancelWorkflowRun(123);
    });

    it('should rerun workflow', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.rerunWorkflowRun(123);
    });

    it('should rerun failed jobs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.rerunFailedJobs(123);
    });
  });

  describe('job operations', () => {
    it('should get jobs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.getJobs(123);
    });

    it('should get job', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const job = await plugin.getJob(456);
      expect(job.id).toBe(456);
    });

    it('should get job logs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const logs = await plugin.getJobLogs(456);
      expect(logs).toBe('logs');
    });

    it('should get failed jobs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.getFailedJobs(123);
    });
  });

  describe('artifact operations', () => {
    it('should list artifacts', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.listArtifacts(123);
    });

    it('should get artifact', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const artifact = await plugin.getArtifact(789);
      expect(artifact.id).toBe(789);
    });

    it('should download artifact', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const data = await plugin.downloadArtifact(789);
      expect(Buffer.isBuffer(data)).toBe(true);
    });

    it('should delete artifact', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.deleteArtifact(789);
    });

    it('should list repo artifacts', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.listRepoArtifacts();
    });
  });

  describe('check run operations', () => {
    it('should create check run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const check = await plugin.createCheckRun({
        name: 'test',
        head_sha: 'abc123def456789012345678901234567890abcd',
      });
      expect(check.id).toBe(1001);
    });

    it('should update check run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.updateCheckRun(1001, { status: 'completed', conclusion: 'success' });
    });

    it('should get check run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const check = await plugin.getCheckRun(1001);
      expect(check.id).toBe(1001);
    });

    it('should list check runs', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.listCheckRuns('main');
    });

    it('should list check runs for suite', async () => {
      const plugin = new GitHubActionsPlugin(config);
      await plugin.listCheckRunsForSuite(2001);
    });
  });

  describe('polling operations', () => {
    it('should create a poller', () => {
      const plugin = new GitHubActionsPlugin(config);
      const poller = plugin.createPoller();
      expect(poller).toBeDefined();
    });

    it('should poll until complete', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const run = await plugin.pollUntilComplete(123);
      expect(run).toBeDefined();
    });

    it('should wait for run', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const result = await plugin.waitForRun(123);
      expect(result.completed).toBe(true);
    });

    it('should start polling', () => {
      const plugin = new GitHubActionsPlugin(config);
      const handle = plugin.startPolling(123);
      expect(handle.cancel).toBeDefined();
    });
  });

  describe('high-level operations', () => {
    it('should trigger and wait', async () => {
      const plugin = new GitHubActionsPlugin(config);
      const run = await plugin.triggerAndWait({ workflow: 'ci.yml' });
      expect(run).toBeDefined();
    });

    it('should get configured workflows', () => {
      const plugin = new GitHubActionsPlugin(config);
      expect(plugin.getCIWorkflow()).toBe('ci.yml');
      expect(plugin.getDeployWorkflow()).toBe('deploy.yml');
      expect(plugin.getTestWorkflow()).toBe('test.yml');
    });
  });

  describe('issue tracker integration', () => {
    it('should set issue tracker', () => {
      const plugin = new GitHubActionsPlugin(config);
      const mockTracker = {
        addComment: vi.fn(),
      };
      plugin.setIssueTracker(mockTracker);
      // No error means success
    });
  });
});

describe('createGitHubActionsPlugin', () => {
  it('should create a plugin instance', () => {
    const plugin = createGitHubActionsPlugin({
      owner: 'test',
      repo: 'repo',
      token: 'token',
    });
    expect(plugin).toBeInstanceOf(GitHubActionsPlugin);
  });
});

describe('PLUGIN_MANIFEST', () => {
  it('should have correct structure', () => {
    expect(PLUGIN_MANIFEST.name).toBe('@generacy-ai/generacy-plugin-github-actions');
    expect(PLUGIN_MANIFEST.version).toBe('0.1.0');
    expect(PLUGIN_MANIFEST.provides).toContain('GitHubActions');
    expect(PLUGIN_MANIFEST.requires).toContainEqual({
      facet: 'EventBus',
      optional: false,
    });
  });
});
