/**
 * Tests for Queue Actions module.
 * Tests cancel, retry, priority adjustment, and view details functionality.
 */
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import type { QueueItem, QueuePriority, QueueStatus } from '../../../../api/types';
import type { QueueTreeProvider } from '../provider';

// Mock vscode - must be at top level with factory function
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    iconPath?: unknown;
    description?: string;
    tooltip?: unknown;
    id?: string;
    command?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {
    id: string;
    color?: unknown;
    constructor(id: string, color?: unknown) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  MarkdownString: class {
    value = '';
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  },
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createWebviewPanel: vi.fn(() => ({
      webview: { html: '' },
    })),
  },
  ViewColumn: { One: 1 },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

// Mock logger
vi.mock('../../../../utils/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock queue API
vi.mock('../../../../api/endpoints/queue', () => ({
  queueApi: {
    cancelQueueItem: vi.fn(),
    retryQueueItem: vi.fn(),
    updatePriority: vi.fn(),
    getQueueItem: vi.fn(),
  },
}));

// Mock WorkItemDetailPanel to avoid deep vscode mock requirements
const mockShowPreview = vi.fn();
vi.mock('../detail-panel', () => ({
  WorkItemDetailPanel: {
    showPreview: (...args: unknown[]) => mockShowPreview(...args),
  },
}));

// Import after mocks are set up
import * as vscode from 'vscode';
import { queueApi } from '../../../../api/endpoints/queue';
import {
  cancelQueueItem,
  retryQueueItem,
  increasePriority,
  decreasePriority,
  viewQueueItemDetails,
} from '../actions';

/**
 * Create a mock queue item for testing
 */
function createMockQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'test-id-123',
    workflowId: 'workflow-456',
    workflowName: 'Test Workflow',
    status: 'pending',
    priority: 'normal',
    repository: 'test-org/test-repo',
    assigneeId: 'user-789',
    queuedAt: '2024-01-15T10:00:00Z',
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    ...overrides,
  };
}

/**
 * Create a mock provider
 */
function createMockProvider(): QueueTreeProvider {
  return {
    refresh: vi.fn(),
    getQueueItemById: vi.fn(),
    getAllItems: vi.fn(),
  } as unknown as QueueTreeProvider;
}

describe('Queue Actions', () => {
  let mockProvider: QueueTreeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = createMockProvider();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('cancelQueueItem', () => {
    it('should show warning for non-cancellable statuses', async () => {
      const item = createMockQueueItem({ status: 'completed' });

      const result = await cancelQueueItem(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot cancel')
      );
      expect(queueApi.cancelQueueItem).not.toHaveBeenCalled();
    });

    it('should return false when user cancels confirmation', async () => {
      const item = createMockQueueItem({ status: 'pending' });
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce(undefined);

      const result = await cancelQueueItem(item, mockProvider);

      expect(result).toBe(false);
      expect(queueApi.cancelQueueItem).not.toHaveBeenCalled();
    });

    it('should cancel pending item when confirmed', async () => {
      const item = createMockQueueItem({ status: 'pending' });
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Cancel Workflow');
      (queueApi.cancelQueueItem as Mock).mockResolvedValueOnce({ success: true });

      const result = await cancelQueueItem(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.cancelQueueItem).toHaveBeenCalledWith(item.id);
      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      expect(mockProvider.refresh).toHaveBeenCalled();
    });

    it('should cancel running item when confirmed', async () => {
      const item = createMockQueueItem({ status: 'running' });
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Cancel Workflow');
      (queueApi.cancelQueueItem as Mock).mockResolvedValueOnce({ success: true });

      const result = await cancelQueueItem(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.cancelQueueItem).toHaveBeenCalledWith(item.id);
    });

    it('should show error message on API failure', async () => {
      const item = createMockQueueItem({ status: 'pending' });
      (vscode.window.showWarningMessage as Mock).mockResolvedValueOnce('Cancel Workflow');
      (queueApi.cancelQueueItem as Mock).mockRejectedValueOnce(new Error('API Error'));

      const result = await cancelQueueItem(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cancel')
      );
    });
  });

  describe('retryQueueItem', () => {
    it('should show warning for non-retryable statuses', async () => {
      const item = createMockQueueItem({ status: 'running' });

      const result = await retryQueueItem(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot retry')
      );
      expect(queueApi.retryQueueItem).not.toHaveBeenCalled();
    });

    it('should retry failed item', async () => {
      const item = createMockQueueItem({ status: 'failed', error: 'Some error' });
      const newItem = createMockQueueItem({ id: 'new-id', status: 'pending' });
      (queueApi.retryQueueItem as Mock).mockResolvedValueOnce(newItem);

      const result = await retryQueueItem(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.retryQueueItem).toHaveBeenCalledWith(item.id);
      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
      expect(mockProvider.refresh).toHaveBeenCalled();
    });

    it('should retry cancelled item', async () => {
      const item = createMockQueueItem({ status: 'cancelled' });
      const newItem = createMockQueueItem({ id: 'new-id', status: 'pending' });
      (queueApi.retryQueueItem as Mock).mockResolvedValueOnce(newItem);

      const result = await retryQueueItem(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.retryQueueItem).toHaveBeenCalledWith(item.id);
    });

    it('should show error message on API failure', async () => {
      const item = createMockQueueItem({ status: 'failed' });
      (queueApi.retryQueueItem as Mock).mockRejectedValueOnce(new Error('API Error'));

      const result = await retryQueueItem(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to retry')
      );
    });
  });

  describe('increasePriority', () => {
    it('should show warning for non-pending status', async () => {
      const item = createMockQueueItem({ status: 'running', priority: 'normal' });

      const result = await increasePriority(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot change priority')
      );
    });

    it('should show info when already at highest priority', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'urgent' });

      const result = await increasePriority(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already at highest priority')
      );
    });

    it('should increase priority from low to normal', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'low' });
      (queueApi.updatePriority as Mock).mockResolvedValueOnce({ ...item, priority: 'normal' });

      const result = await increasePriority(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.updatePriority).toHaveBeenCalledWith(item.id, 'normal');
      expect(mockProvider.refresh).toHaveBeenCalled();
    });

    it('should increase priority from normal to high', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'normal' });
      (queueApi.updatePriority as Mock).mockResolvedValueOnce({ ...item, priority: 'high' });

      const result = await increasePriority(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.updatePriority).toHaveBeenCalledWith(item.id, 'high');
    });

    it('should increase priority from high to urgent', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'high' });
      (queueApi.updatePriority as Mock).mockResolvedValueOnce({ ...item, priority: 'urgent' });

      const result = await increasePriority(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.updatePriority).toHaveBeenCalledWith(item.id, 'urgent');
    });
  });

  describe('decreasePriority', () => {
    it('should show warning for non-pending status', async () => {
      const item = createMockQueueItem({ status: 'completed', priority: 'normal' });

      const result = await decreasePriority(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot change priority')
      );
    });

    it('should show info when already at lowest priority', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'low' });

      const result = await decreasePriority(item, mockProvider);

      expect(result).toBe(false);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('already at lowest priority')
      );
    });

    it('should decrease priority from urgent to high', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'urgent' });
      (queueApi.updatePriority as Mock).mockResolvedValueOnce({ ...item, priority: 'high' });

      const result = await decreasePriority(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.updatePriority).toHaveBeenCalledWith(item.id, 'high');
      expect(mockProvider.refresh).toHaveBeenCalled();
    });

    it('should decrease priority from normal to low', async () => {
      const item = createMockQueueItem({ status: 'pending', priority: 'normal' });
      (queueApi.updatePriority as Mock).mockResolvedValueOnce({ ...item, priority: 'low' });

      const result = await decreasePriority(item, mockProvider);

      expect(result).toBe(true);
      expect(queueApi.updatePriority).toHaveBeenCalledWith(item.id, 'low');
    });
  });

  describe('viewQueueItemDetails', () => {
    const mockExtensionUri = { fsPath: '/mock/extension' } as vscode.Uri;

    beforeEach(() => {
      mockShowPreview.mockReset();
    });

    it('should delegate to WorkItemDetailPanel.showPreview', async () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: '2024-01-15T10:05:00Z',
      });
      (queueApi.getQueueItem as Mock).mockResolvedValueOnce(item);

      await viewQueueItemDetails(item, mockExtensionUri);

      expect(mockShowPreview).toHaveBeenCalledWith(item, mockExtensionUri);
    });

    it('should fetch fresh data from API', async () => {
      const item = createMockQueueItem();
      const freshItem = { ...item, status: 'completed' as QueueStatus };
      (queueApi.getQueueItem as Mock).mockResolvedValueOnce(freshItem);

      await viewQueueItemDetails(item, mockExtensionUri);

      expect(queueApi.getQueueItem).toHaveBeenCalledWith(item.id);
      expect(mockShowPreview).toHaveBeenCalledWith(freshItem, mockExtensionUri);
    });

    it('should use cached data when API fetch fails', async () => {
      const item = createMockQueueItem();
      (queueApi.getQueueItem as Mock).mockRejectedValueOnce(new Error('API Error'));

      await viewQueueItemDetails(item, mockExtensionUri);

      // Should still show preview with cached data
      expect(mockShowPreview).toHaveBeenCalledWith(item, mockExtensionUri);
    });

    it('should pass fresh item with error details to panel', async () => {
      const item = createMockQueueItem({
        status: 'failed',
        error: 'Connection timeout',
      });
      (queueApi.getQueueItem as Mock).mockResolvedValueOnce(item);

      await viewQueueItemDetails(item, mockExtensionUri);

      expect(mockShowPreview).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Connection timeout' }),
        mockExtensionUri
      );
    });
  });

  describe('priority order', () => {
    it('should follow correct priority order: low -> normal -> high -> urgent', async () => {
      const priorities: QueuePriority[] = ['low', 'normal', 'high', 'urgent'];

      for (let i = 0; i < priorities.length - 1; i++) {
        vi.clearAllMocks();
        const item = createMockQueueItem({ status: 'pending', priority: priorities[i] });
        (queueApi.updatePriority as Mock).mockResolvedValueOnce({
          ...item,
          priority: priorities[i + 1],
        });

        await increasePriority(item, mockProvider);

        expect(queueApi.updatePriority).toHaveBeenLastCalledWith(item.id, priorities[i + 1]);
      }
    });
  });
});
