/**
 * Tests for QueueTreeProvider
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueueItem, QueueListResponse } from '../../../../api/types';

// Mock modules
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
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
  EventEmitter: class {
    private listeners: Array<(data: unknown) => void> = [];
    event = (listener: (data: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire = (data?: unknown) => {
      this.listeners.forEach((l) => l(data));
    };
    dispose = () => {
      this.listeners = [];
    };
  },
  window: {
    createTreeView: vi.fn(() => ({
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
    showQuickPick: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Disposable: class {
    dispose = vi.fn();
  },
}));

vi.mock('../../../../utils/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../api/auth', () => ({
  getAuthService: () => ({
    isAuthenticated: vi.fn(() => true),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  }),
}));

vi.mock('../../../../api/endpoints/queue', () => ({
  queueApi: {
    getQueue: vi.fn(),
    getQueueItem: vi.fn(),
    cancelQueueItem: vi.fn(),
    retryQueueItem: vi.fn(),
    updatePriority: vi.fn(),
  },
}));

vi.mock('../../../../constants', () => ({
  VIEWS: { queue: 'generacy.queue' },
  TREE_ITEM_CONTEXT: { queueItem: 'queueItem' },
}));

// Import after mocks
import { QueueTreeProvider } from '../provider';
import { QueueTreeItem, QueueEmptyItem, QueueLoadingItem, QueueFilterGroupItem } from '../tree-item';
import { queueApi } from '../../../../api/endpoints/queue';

// Get reference to the mocked API
const mockQueueApi = vi.mocked(queueApi);

describe('QueueTreeProvider', () => {
  let provider: QueueTreeProvider;

  const createMockQueueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
    id: `item-${Math.random().toString(36).slice(2)}`,
    workflowId: 'workflow-123',
    workflowName: 'Test Workflow',
    status: 'pending',
    priority: 'normal',
    queuedAt: new Date().toISOString(),
    ...overrides,
  });

  const createMockResponse = (items: QueueItem[]): QueueListResponse => ({
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockQueueApi.getQueue.mockResolvedValue(createMockResponse([]));
  });

  afterEach(() => {
    provider?.dispose();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should create a provider instance', () => {
      provider = new QueueTreeProvider();
      expect(provider).toBeInstanceOf(QueueTreeProvider);
    });

    it('should respect custom polling interval', () => {
      provider = new QueueTreeProvider({ pollingInterval: 60000 });
      expect(provider).toBeDefined();
    });

    it('should respect custom page size', () => {
      provider = new QueueTreeProvider({ pageSize: 100 });
      expect(provider).toBeDefined();
    });

    it('should start polling on initialization when authenticated', async () => {
      provider = new QueueTreeProvider();

      // Advance timer to trigger initial fetch
      await vi.advanceTimersByTimeAsync(0);

      expect(mockQueueApi.getQueue).toHaveBeenCalled();
    });
  });

  describe('getChildren - root level', () => {
    it('should return empty message when no items', async () => {
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse([]));
      provider = new QueueTreeProvider();

      await vi.advanceTimersByTimeAsync(0);
      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(QueueEmptyItem);
    });

    it('should return tree items in flat mode', async () => {
      const items = [
        createMockQueueItem({ workflowName: 'Workflow 1' }),
        createMockQueueItem({ workflowName: 'Workflow 2' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider({ viewMode: 'flat' });

      await vi.advanceTimersByTimeAsync(0);
      const children = await provider.getChildren();

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(QueueTreeItem);
      expect(children[1]).toBeInstanceOf(QueueTreeItem);
    });

    it('should return status groups in byStatus mode', async () => {
      const items = [
        createMockQueueItem({ status: 'pending' }),
        createMockQueueItem({ status: 'running' }),
        createMockQueueItem({ status: 'pending' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider({ viewMode: 'byStatus' });

      await vi.advanceTimersByTimeAsync(0);
      const children = await provider.getChildren();

      // Should have 2 groups: pending (2) and running (1)
      expect(children).toHaveLength(2);
      expect(children.every((c) => c instanceof QueueFilterGroupItem)).toBe(true);
    });

    it('should return repository groups in byRepository mode', async () => {
      const items = [
        createMockQueueItem({ repository: 'owner/repo1' }),
        createMockQueueItem({ repository: 'owner/repo2' }),
        createMockQueueItem({ repository: 'owner/repo1' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider({ viewMode: 'byRepository' });

      await vi.advanceTimersByTimeAsync(0);
      const children = await provider.getChildren();

      expect(children).toHaveLength(2);
      expect(children.every((c) => c instanceof QueueFilterGroupItem)).toBe(true);
    });
  });

  describe('getChildren - filter group level', () => {
    it('should return items matching status filter', async () => {
      const items = [
        createMockQueueItem({ status: 'pending', workflowName: 'Pending 1' }),
        createMockQueueItem({ status: 'running', workflowName: 'Running 1' }),
        createMockQueueItem({ status: 'pending', workflowName: 'Pending 2' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider({ viewMode: 'byStatus' });

      await vi.advanceTimersByTimeAsync(0);

      // Get the pending filter group
      const filterGroup = new QueueFilterGroupItem('Pending', 'status', 'pending', 2);
      const children = await provider.getChildren(filterGroup);

      expect(children).toHaveLength(2);
      expect(children.every((c) => c instanceof QueueTreeItem)).toBe(true);
      expect(children.every((c) => (c as QueueTreeItem).queueItem.status === 'pending')).toBe(true);
    });
  });

  describe('view modes', () => {
    it('should change view mode', async () => {
      provider = new QueueTreeProvider({ viewMode: 'flat' });
      expect(provider.getViewMode()).toBe('flat');

      provider.setViewMode('byStatus');
      expect(provider.getViewMode()).toBe('byStatus');

      provider.setViewMode('byRepository');
      expect(provider.getViewMode()).toBe('byRepository');

      provider.setViewMode('byAssignee');
      expect(provider.getViewMode()).toBe('byAssignee');
    });
  });

  describe('filtering', () => {
    it('should apply status filter', async () => {
      provider = new QueueTreeProvider();

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      vi.clearAllMocks();

      // Now apply filter which triggers a new fetch
      provider.setStatusFilter('running');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockQueueApi.getQueue).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' })
      );
    });

    it('should apply repository filter', async () => {
      provider = new QueueTreeProvider();

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      vi.clearAllMocks();

      // Now apply filter
      provider.setRepositoryFilter('owner/repo');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockQueueApi.getQueue).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'owner/repo' })
      );
    });

    it('should apply assignee filter', async () => {
      provider = new QueueTreeProvider();

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      vi.clearAllMocks();

      // Now apply filter
      provider.setAssigneeFilter('user-123');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockQueueApi.getQueue).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'user-123' })
      );
    });

    it('should clear all filters', async () => {
      provider = new QueueTreeProvider();
      await vi.advanceTimersByTimeAsync(0);

      provider.setStatusFilter('running');
      provider.setRepositoryFilter('owner/repo');
      provider.clearFilters();

      const filters = provider.getFilters();
      expect(filters).toEqual({});
    });
  });

  describe('polling', () => {
    it('should poll at the specified interval', async () => {
      provider = new QueueTreeProvider({ pollingInterval: 10000 });

      // Initial fetch
      await vi.advanceTimersByTimeAsync(0);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1);

      // After interval
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(2);

      // After another interval
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(3);
    });

    it('should stop polling on dispose', async () => {
      provider = new QueueTreeProvider({ pollingInterval: 10000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1);

      provider.dispose();

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1); // No additional calls
    });

    it('should pause and resume polling', async () => {
      provider = new QueueTreeProvider({ pollingInterval: 10000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1);

      provider.pausePolling();

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1); // No calls while paused

      provider.resumePolling();
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(2); // Called on resume
    });
  });

  describe('manual refresh', () => {
    it('should fetch immediately on refresh', async () => {
      provider = new QueueTreeProvider();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(1);

      provider.refresh();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockQueueApi.getQueue).toHaveBeenCalledTimes(2);
    });
  });

  describe('item access', () => {
    it('should return all items', async () => {
      const items = [
        createMockQueueItem({ id: '1' }),
        createMockQueueItem({ id: '2' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider();

      await vi.advanceTimersByTimeAsync(0);

      const allItems = provider.getAllItems();
      expect(allItems).toHaveLength(2);
    });

    it('should find item by ID', async () => {
      const items = [
        createMockQueueItem({ id: 'target-id', workflowName: 'Target' }),
        createMockQueueItem({ id: 'other-id', workflowName: 'Other' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider();

      await vi.advanceTimersByTimeAsync(0);

      const found = provider.getQueueItemById('target-id');
      expect(found?.workflowName).toBe('Target');
    });

    it('should return items by status', async () => {
      const items = [
        createMockQueueItem({ status: 'pending' }),
        createMockQueueItem({ status: 'running' }),
        createMockQueueItem({ status: 'pending' }),
      ];
      mockQueueApi.getQueue.mockResolvedValue(createMockResponse(items));
      provider = new QueueTreeProvider();

      await vi.advanceTimersByTimeAsync(0);

      const pendingItems = provider.getItemsByStatus('pending');
      expect(pendingItems).toHaveLength(2);
    });
  });

  describe('change detection', () => {
    it('should detect when queue items change', async () => {
      const initialItems = [createMockQueueItem({ id: '1', status: 'pending' })];
      const updatedItems = [createMockQueueItem({ id: '1', status: 'running' })];

      mockQueueApi.getQueue
        .mockResolvedValueOnce(createMockResponse(initialItems))
        .mockResolvedValueOnce(createMockResponse(updatedItems));

      provider = new QueueTreeProvider({ pollingInterval: 10000 });

      // Initial fetch
      await vi.advanceTimersByTimeAsync(0);
      let items = provider.getAllItems();
      expect(items[0]?.status).toBe('pending');

      // After polling interval
      await vi.advanceTimersByTimeAsync(10000);
      items = provider.getAllItems();
      expect(items[0]?.status).toBe('running');
    });
  });
});
