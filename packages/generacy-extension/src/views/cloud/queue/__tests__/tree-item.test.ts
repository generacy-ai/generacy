/**
 * Tests for Queue Tree Items
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueueItem } from '../../../../api/types';

// Mock vscode before imports
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
}));

// Import after mock
import {
  QueueTreeItem,
  QueueFilterGroupItem,
  QueueEmptyItem,
  QueueLoadingItem,
  QueueErrorItem,
  isQueueTreeItem,
  isQueueFilterGroupItem,
} from '../tree-item';

describe('QueueTreeItem', () => {
  const createMockQueueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
    id: 'test-id',
    workflowId: 'workflow-123',
    workflowName: 'Test Workflow',
    status: 'pending',
    priority: 'normal',
    queuedAt: new Date().toISOString(),
    ...overrides,
  });

  describe('constructor', () => {
    it('should create a tree item with correct label', () => {
      const queueItem = createMockQueueItem({ workflowName: 'My Workflow' });
      const treeItem = new QueueTreeItem(queueItem);

      expect(treeItem.label).toBe('My Workflow');
    });

    it('should set unique ID', () => {
      const queueItem = createMockQueueItem({ id: 'unique-123' });
      const treeItem = new QueueTreeItem(queueItem);

      expect(treeItem.id).toBe('unique-123');
    });

    it('should store the queue item', () => {
      const queueItem = createMockQueueItem();
      const treeItem = new QueueTreeItem(queueItem);

      expect(treeItem.queueItem).toBe(queueItem);
    });
  });

  describe('status icons', () => {
    it('should set clock icon for pending status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'pending' }));
      expect((treeItem.iconPath as { id: string }).id).toBe('clock');
    });

    it('should set sync icon for running status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'running' }));
      expect((treeItem.iconPath as { id: string }).id).toBe('sync~spin');
    });

    it('should set check icon for completed status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'completed' }));
      expect((treeItem.iconPath as { id: string }).id).toBe('check');
    });

    it('should set error icon for failed status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'failed' }));
      expect((treeItem.iconPath as { id: string }).id).toBe('error');
    });

    it('should set circle-slash icon for cancelled status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'cancelled' }));
      expect((treeItem.iconPath as { id: string }).id).toBe('circle-slash');
    });
  });

  describe('context value', () => {
    it('should include status in context value', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'running' }));
      expect(treeItem.contextValue).toBe('queueItem-running');
    });

    it('should work for all statuses', () => {
      const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;

      for (const status of statuses) {
        const treeItem = new QueueTreeItem(createMockQueueItem({ status }));
        expect(treeItem.contextValue).toBe(`queueItem-${status}`);
      }
    });
  });

  describe('description', () => {
    it('should include repository in description', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ repository: 'owner/repo' })
      );
      expect(treeItem.description).toContain('owner/repo');
    });

    it('should handle missing repository', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ repository: undefined })
      );
      expect(treeItem.description).not.toContain('undefined');
    });
  });

  describe('tooltip', () => {
    it('should include workflow name', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ workflowName: 'My Test Workflow' })
      );
      expect((treeItem.tooltip as { value: string }).value).toContain('My Test Workflow');
    });

    it('should include error message for failed items', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'failed',
          error: 'Something went wrong',
        })
      );
      expect((treeItem.tooltip as { value: string }).value).toContain('Something went wrong');
    });
  });
});

describe('QueueFilterGroupItem', () => {
  it('should create a collapsed tree item', () => {
    const item = new QueueFilterGroupItem('Pending', 'status', 'pending', 5);
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it('should show count in description', () => {
    const item = new QueueFilterGroupItem('Running', 'status', 'running', 10);
    expect(item.description).toBe('(10)');
  });

  it('should set context value based on filter type', () => {
    const statusItem = new QueueFilterGroupItem('Pending', 'status', 'pending', 5);
    expect(statusItem.contextValue).toBe('queueFilter-status');

    const repoItem = new QueueFilterGroupItem('owner/repo', 'repository', 'owner/repo', 3);
    expect(repoItem.contextValue).toBe('queueFilter-repository');

    const assigneeItem = new QueueFilterGroupItem('User', 'assignee', 'user-123', 2);
    expect(assigneeItem.contextValue).toBe('queueFilter-assignee');
  });

  it('should store filter metadata', () => {
    const item = new QueueFilterGroupItem('Pending', 'status', 'pending', 5);
    expect(item.filterType).toBe('status');
    expect(item.filterValue).toBe('pending');
  });
});

describe('Placeholder items', () => {
  describe('QueueEmptyItem', () => {
    it('should display the provided message', () => {
      const item = new QueueEmptyItem('No items found');
      expect(item.label).toBe('No items found');
    });

    it('should not be collapsible', () => {
      const item = new QueueEmptyItem('Empty');
      expect(item.collapsibleState).toBe(0); // None
    });

    it('should have correct context value', () => {
      const item = new QueueEmptyItem('Empty');
      expect(item.contextValue).toBe('queueEmpty');
    });
  });

  describe('QueueLoadingItem', () => {
    it('should show loading message', () => {
      const item = new QueueLoadingItem();
      expect(item.label).toBe('Loading queue...');
    });

    it('should have spinning sync icon', () => {
      const item = new QueueLoadingItem();
      expect((item.iconPath as { id: string }).id).toBe('sync~spin');
    });

    it('should have correct context value', () => {
      const item = new QueueLoadingItem();
      expect(item.contextValue).toBe('queueLoading');
    });
  });

  describe('QueueErrorItem', () => {
    it('should show error message', () => {
      const error = new Error('Network error');
      const item = new QueueErrorItem(error);
      expect(item.label).toBe('Failed to load queue');
    });

    it('should store the error', () => {
      const error = new Error('Test error');
      const item = new QueueErrorItem(error);
      expect(item.error).toBe(error);
    });

    it('should have error icon', () => {
      const item = new QueueErrorItem(new Error('Test'));
      expect((item.iconPath as { id: string }).id).toBe('error');
    });

    it('should have retry command', () => {
      const item = new QueueErrorItem(new Error('Test'));
      expect(item.command?.command).toBe('generacy.queue.refresh');
    });
  });
});

describe('Type guards', () => {
  describe('isQueueTreeItem', () => {
    it('should return true for QueueTreeItem', () => {
      const item = new QueueTreeItem(createMockQueueItem());
      expect(isQueueTreeItem(item)).toBe(true);
    });

    it('should return false for other items', () => {
      const item = new QueueEmptyItem('Empty');
      expect(isQueueTreeItem(item)).toBe(false);
    });
  });

  describe('isQueueFilterGroupItem', () => {
    it('should return true for QueueFilterGroupItem', () => {
      const item = new QueueFilterGroupItem('Test', 'status', 'pending', 5);
      expect(isQueueFilterGroupItem(item)).toBe(true);
    });

    it('should return false for other items', () => {
      const item = new QueueTreeItem(createMockQueueItem());
      expect(isQueueFilterGroupItem(item)).toBe(false);
    });
  });
});

function createMockQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'test-id',
    workflowId: 'workflow-123',
    workflowName: 'Test Workflow',
    status: 'pending',
    priority: 'normal',
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}
