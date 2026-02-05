/**
 * Tests for github.sync_labels action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncLabelsAction } from '../../../src/actions/github/sync-labels.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
};

// Helper to create mock context
function createMockContext(inputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    inputs,
    outputs: {},
    env: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    signal: new AbortController().signal,
    refs: {},
  };
}

// Helper to create step definition
function createStep(inputs: Record<string, unknown> = {}): StepDefinition {
  return {
    name: 'test-step',
    uses: 'github.sync_labels',
    with: inputs,
  };
}

describe('SyncLabelsAction', () => {
  let action: SyncLabelsAction;

  beforeEach(() => {
    action = new SyncLabelsAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.listLabels.mockResolvedValue([]);
    mockGitHubClient.createLabel.mockResolvedValue(undefined);
    mockGitHubClient.updateLabel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.sync_labels action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.preflight',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('runs in dry_run mode by default', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      // Should not actually create labels in dry run
      expect(mockGitHubClient.createLabel).not.toHaveBeenCalled();
      expect(mockGitHubClient.updateLabel).not.toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect((output.created as string[]).length).toBeGreaterThan(0);
    });

    it('creates labels when dry_run is false', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([]);

      const step = createStep({ dry_run: false });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      // Should create labels for empty repo
      expect(mockGitHubClient.createLabel).toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect((output.created as string[]).length).toBeGreaterThan(0);
    });

    it('reports unchanged labels when they match', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([
        { name: 'phase:specify', color: '0052CC', description: 'Specification phase' },
        { name: 'phase:clarify', color: '0052CC', description: 'Clarification phase' },
      ]);

      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect((output.unchanged as string[])).toContain('phase:specify');
      expect((output.unchanged as string[])).toContain('phase:clarify');
    });

    it('updates labels when color differs', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([
        { name: 'phase:specify', color: 'FFFFFF', description: 'Specification phase' },
      ]);

      const step = createStep({ dry_run: false });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updateLabel).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        'phase:specify',
        expect.objectContaining({
          color: '0052CC',
        })
      );

      const output = result.output as Record<string, unknown>;
      expect((output.updated as string[])).toContain('phase:specify');
    });

    it('updates labels when description differs', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([
        { name: 'phase:specify', color: '0052CC', description: 'Old description' },
      ]);

      const step = createStep({ dry_run: false });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updateLabel).toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect((output.updated as string[])).toContain('phase:specify');
    });

    it('returns results array with action type for each label', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([
        { name: 'phase:specify', color: '0052CC', description: 'Specification phase' },
        { name: 'phase:clarify', color: 'FFFFFF', description: 'Clarification phase' },
      ]);

      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const results = output.results as Array<{ name: string; action: string }>;

      // Find specific labels in results
      const specifyResult = results.find(r => r.name === 'phase:specify');
      const clarifyResult = results.find(r => r.name === 'phase:clarify');
      const planResult = results.find(r => r.name === 'phase:plan');

      expect(specifyResult?.action).toBe('unchanged');
      expect(clarifyResult?.action).toBe('updated');
      expect(planResult?.action).toBe('created');
    });

    it('includes all workflow label categories', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const created = output.created as string[];

      // Check that different categories of labels are included
      expect(created.some(l => l.startsWith('phase:'))).toBe(true);
      expect(created.some(l => l.startsWith('waiting-for:'))).toBe(true);
      expect(created.some(l => l.startsWith('completed:'))).toBe(true);
      expect(created.some(l => l.startsWith('type:'))).toBe(true);
      expect(created.some(l => l.startsWith('agent:'))).toBe(true);
      expect(created.some(l => l.startsWith('needs:'))).toBe(true);
    });

    it('handles API errors gracefully', async () => {
      mockGitHubClient.getRepoInfo.mockRejectedValue(new Error('Not Found'));

      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not Found');
    });

    it('handles label creation errors', async () => {
      mockGitHubClient.createLabel.mockRejectedValue(new Error('Rate limited'));

      const step = createStep({ dry_run: false });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
    });

    it('logs operations in dry_run mode', async () => {
      mockGitHubClient.listLabels.mockResolvedValue([]);

      const step = createStep({ dry_run: true });
      const context = createMockContext();

      await action.execute(step, context);

      // Should log dry run message
      expect(context.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('dry_run: true')
      );
      // Should log what would be created
      expect(context.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would create')
      );
    });
  });
});
