/**
 * Tests for Queue Tree Items
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueueItem, QueueItemProgressSummary } from '../../../../api/types';

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

/** Helper to create a mock QueueItem with sensible defaults */
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

/** Helper to create a progress summary */
function createProgressSummary(overrides: Partial<QueueItemProgressSummary> = {}): QueueItemProgressSummary {
  return {
    currentPhase: 'implementation',
    phaseProgress: 'Phase 5/8',
    totalPhases: 8,
    completedPhases: 4,
    ...overrides,
  };
}

/** Helper to get tooltip value */
function getTooltipValue(treeItem: QueueTreeItem): string {
  return (treeItem.tooltip as { value: string }).value;
}

/** Helper to get icon id */
function getIconId(treeItem: QueueTreeItem): string {
  return (treeItem.iconPath as { id: string }).id;
}

/** Helper to get icon color */
function getIconColor(treeItem: QueueTreeItem): string | undefined {
  return (treeItem.iconPath as { color?: { id: string } }).color?.id;
}

describe('QueueTreeItem', () => {
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

    it('should set collapsible state to None', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem());
      expect(treeItem.collapsibleState).toBe(0); // None
    });
  });

  describe('status icons', () => {
    it('should set clock icon for pending status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'pending' }));
      expect(getIconId(treeItem)).toBe('clock');
    });

    it('should set sync icon for running status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'running' }));
      expect(getIconId(treeItem)).toBe('sync~spin');
    });

    it('should set check icon for completed status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'completed' }));
      expect(getIconId(treeItem)).toBe('check');
    });

    it('should set error icon for failed status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'failed' }));
      expect(getIconId(treeItem)).toBe('error');
    });

    it('should set circle-slash icon for cancelled status', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'cancelled' }));
      expect(getIconId(treeItem)).toBe('circle-slash');
    });
  });

  describe('status icon colors', () => {
    it('should use yellow for pending', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'pending' }));
      expect(getIconColor(treeItem)).toBe('charts.yellow');
    });

    it('should use blue for running', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'running' }));
      expect(getIconColor(treeItem)).toBe('charts.blue');
    });

    it('should use green for completed', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'completed' }));
      expect(getIconColor(treeItem)).toBe('charts.green');
    });

    it('should use red for failed', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'failed' }));
      expect(getIconColor(treeItem)).toBe('charts.red');
    });

    it('should use gray for cancelled', () => {
      const treeItem = new QueueTreeItem(createMockQueueItem({ status: 'cancelled' }));
      expect(getIconColor(treeItem)).toBe('charts.gray');
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

    it('should join parts with bullet separator', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ repository: 'owner/repo', status: 'pending' })
      );
      expect(treeItem.description).toContain('•');
    });
  });

  describe('progress-aware description', () => {
    it('should show phase progress for running job with progress', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 60000).toISOString(),
      });
      const progress = createProgressSummary({
        phaseProgress: 'Phase 5/8',
        currentPhase: 'implementation',
      });
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).toContain('Phase 5/8');
      expect(treeItem.description).toContain('implementation');
    });

    it('should show skipped phases count when present', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 60000).toISOString(),
      });
      const progress = createProgressSummary({
        phaseProgress: 'Phase 5/8',
        skippedPhases: 2,
        currentPhase: 'implementation',
      });
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).toContain('Phase 5/8 (2 skipped)');
      expect(treeItem.description).toContain('implementation');
    });

    it('should not show skipped count when zero', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 60000).toISOString(),
      });
      const progress = createProgressSummary({
        phaseProgress: 'Phase 3/5',
        skippedPhases: 0,
        currentPhase: 'planning',
      });
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('skipped');
    });

    it('should show phase progress without current phase name if not provided', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 60000).toISOString(),
      });
      const progress = createProgressSummary({
        phaseProgress: 'Phase 2/6',
        currentPhase: undefined,
      });
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).toContain('Phase 2/6');
      // Should not have the middle-dot separator for current phase
      const desc = treeItem.description as string;
      const progressPart = desc.split(' • ').find((p) => p.startsWith('Phase'));
      expect(progressPart).toBe('Phase 2/6');
    });

    it('should fall back to time format for running job without progress', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
      });
      const treeItem = new QueueTreeItem(item);

      expect(treeItem.description).toContain('running for');
      expect(treeItem.description).not.toContain('Phase');
    });

    it('should fall back when progress has no phaseProgress', () => {
      const item = createMockQueueItem({
        status: 'running',
        startedAt: new Date(Date.now() - 60000).toISOString(),
      });
      const progress: QueueItemProgressSummary = {
        currentPhase: 'setup',
        // no phaseProgress
      };
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('Phase');
      expect(treeItem.description).toContain('running for');
    });

    it('should not show progress for completed job even with progress data', () => {
      const startedAt = new Date(Date.now() - 300000).toISOString();
      const completedAt = new Date(Date.now() - 60000).toISOString();
      const item = createMockQueueItem({
        status: 'completed',
        startedAt,
        completedAt,
      });
      const progress = createProgressSummary();
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('Phase');
      expect(treeItem.description).toContain('completed in');
    });

    it('should not show progress for pending job', () => {
      const item = createMockQueueItem({ status: 'pending' });
      const progress = createProgressSummary();
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('Phase');
      expect(treeItem.description).toContain('queued');
    });

    it('should not show progress for failed job', () => {
      const item = createMockQueueItem({
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      const progress = createProgressSummary();
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('Phase');
      expect(treeItem.description).toContain('failed');
    });

    it('should not show progress for cancelled job', () => {
      const item = createMockQueueItem({
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
      const progress = createProgressSummary();
      const treeItem = new QueueTreeItem(item, progress);

      expect(treeItem.description).not.toContain('Phase');
      expect(treeItem.description).toContain('cancelled');
    });

    it('should combine repository, progress, and time info', () => {
      const item = createMockQueueItem({
        status: 'running',
        repository: 'org/project',
        startedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
      });
      const progress = createProgressSummary({
        phaseProgress: 'Phase 3/6',
        currentPhase: 'planning',
      });
      const treeItem = new QueueTreeItem(item, progress);

      const desc = treeItem.description as string;
      const parts = desc.split(' • ');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('org/project');
      expect(parts[1]).toContain('Phase 3/6');
      expect(parts[1]).toContain('planning');
      expect(parts[2]).toContain('running for');
    });
  });

  describe('time info', () => {
    it('should show "queued" with relative time for pending items', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'pending',
          queuedAt: new Date().toISOString(),
        })
      );
      expect(treeItem.description).toContain('queued');
    });

    it('should show "running for" with duration for running items', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'running',
          startedAt: new Date(Date.now() - 180000).toISOString(), // 3 min ago
        })
      );
      expect(treeItem.description).toContain('running for 3m');
    });

    it('should show "starting..." for running without startedAt', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'running' })
      );
      expect(treeItem.description).toContain('starting...');
    });

    it('should show "completed in" with duration for completed items', () => {
      const startedAt = new Date(Date.now() - 300000).toISOString(); // 5 min ago
      const completedAt = new Date(Date.now() - 60000).toISOString(); // 1 min ago
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'completed', startedAt, completedAt })
      );
      expect(treeItem.description).toContain('completed in 4m');
    });

    it('should show relative time for completed without startedAt', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
      );
      expect(treeItem.description).toContain('just now');
    });

    it('should show "failed" with relative time', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'failed',
          completedAt: new Date().toISOString(),
        })
      );
      expect(treeItem.description).toContain('failed just now');
    });

    it('should show "failed" without time when no completedAt', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'failed' })
      );
      expect(treeItem.description).toContain('failed');
    });

    it('should show "cancelled" with relative time', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'cancelled',
          completedAt: new Date().toISOString(),
        })
      );
      expect(treeItem.description).toContain('cancelled just now');
    });

    it('should show "cancelled" without time when no completedAt', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'cancelled' })
      );
      expect(treeItem.description).toContain('cancelled');
    });

    it('should format seconds duration', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'running',
          startedAt: new Date(Date.now() - 30000).toISOString(), // 30 sec ago
        })
      );
      expect(treeItem.description).toContain('running for 30s');
    });

    it('should format hours and minutes duration', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'running',
          startedAt: new Date(Date.now() - 5400000).toISOString(), // 1h 30m ago
        })
      );
      expect(treeItem.description).toContain('running for 1h 30m');
    });

    it('should show minutes ago for relative time', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'pending',
          queuedAt: new Date(Date.now() - 300000).toISOString(), // 5 min ago
        })
      );
      expect(treeItem.description).toContain('queued 5m ago');
    });

    it('should show hours ago for relative time', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'pending',
          queuedAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
        })
      );
      expect(treeItem.description).toContain('queued 2h ago');
    });

    it('should show days ago for relative time', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'pending',
          queuedAt: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
        })
      );
      expect(treeItem.description).toContain('queued 2d ago');
    });
  });

  describe('tooltip', () => {
    it('should include workflow name as heading', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ workflowName: 'My Test Workflow' })
      );
      expect(getTooltipValue(treeItem)).toContain('## My Test Workflow');
    });

    it('should include status with icon', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'running' })
      );
      expect(getTooltipValue(treeItem)).toContain('$(sync~spin)');
      expect(getTooltipValue(treeItem)).toContain('Running');
    });

    it('should include priority with icon', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ priority: 'high' })
      );
      expect(getTooltipValue(treeItem)).toContain('$(arrow-up)');
      expect(getTooltipValue(treeItem)).toContain('High');
    });

    it('should include all priority icons', () => {
      const priorities: Array<{ priority: 'low' | 'normal' | 'high' | 'urgent'; icon: string }> = [
        { priority: 'low', icon: '$(arrow-down)' },
        { priority: 'normal', icon: '$(dash)' },
        { priority: 'high', icon: '$(arrow-up)' },
        { priority: 'urgent', icon: '$(flame)' },
      ];

      for (const { priority, icon } of priorities) {
        const treeItem = new QueueTreeItem(createMockQueueItem({ priority }));
        expect(getTooltipValue(treeItem)).toContain(icon);
      }
    });

    it('should include repository when present', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ repository: 'owner/repo' })
      );
      expect(getTooltipValue(treeItem)).toContain('`owner/repo`');
    });

    it('should not include repository line when absent', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ repository: undefined })
      );
      expect(getTooltipValue(treeItem)).not.toContain('Repository');
    });

    it('should include workflow ID', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ workflowId: 'wf-abc-123' })
      );
      expect(getTooltipValue(treeItem)).toContain('`wf-abc-123`');
    });

    it('should include queued timestamp', () => {
      const queuedAt = '2026-02-23T10:00:00.000Z';
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ queuedAt })
      );
      expect(getTooltipValue(treeItem)).toContain('**Queued:**');
    });

    it('should include started timestamp when present', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'running',
          startedAt: '2026-02-23T10:05:00.000Z',
        })
      );
      expect(getTooltipValue(treeItem)).toContain('**Started:**');
    });

    it('should not include started timestamp when absent', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'pending' })
      );
      expect(getTooltipValue(treeItem)).not.toContain('**Started:**');
    });

    it('should include completed timestamp when present', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'completed',
          startedAt: '2026-02-23T10:00:00.000Z',
          completedAt: '2026-02-23T10:05:00.000Z',
        })
      );
      expect(getTooltipValue(treeItem)).toContain('**Completed:**');
    });

    it('should include error message for failed items', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({
          status: 'failed',
          error: 'Something went wrong',
        })
      );
      expect(getTooltipValue(treeItem)).toContain('Something went wrong');
      expect(getTooltipValue(treeItem)).toContain('**Error:**');
    });

    it('should not include error section when no error', () => {
      const treeItem = new QueueTreeItem(
        createMockQueueItem({ status: 'completed' })
      );
      expect(getTooltipValue(treeItem)).not.toContain('**Error:**');
    });

    describe('progress in tooltip', () => {
      it('should include progress section when progress is available', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 5/8',
          currentPhase: 'implementation',
        });
        const treeItem = new QueueTreeItem(item, progress);
        const tooltip = getTooltipValue(treeItem);

        expect(tooltip).toContain('### Progress');
        expect(tooltip).toContain('Phase 5/8');
        expect(tooltip).toContain('implementation');
      });

      it('should show skipped phases in tooltip', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 5/8',
          skippedPhases: 2,
        });
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).toContain('(2 skipped)');
      });

      it('should not show skipped when zero', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 3/5',
          skippedPhases: 0,
        });
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).not.toContain('skipped');
      });

      it('should show current phase name in tooltip', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 2/6',
          currentPhase: 'specification',
        });
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).toContain('**Current Phase:** specification');
      });

      it('should not show current phase line when not provided', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 2/6',
          currentPhase: undefined,
        });
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).not.toContain('**Current Phase:**');
      });

      it('should not show progress section when no phaseProgress', () => {
        const item = createMockQueueItem({ status: 'running' });
        const progress: QueueItemProgressSummary = {
          currentPhase: 'setup',
        };
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).not.toContain('### Progress');
      });

      it('should not show progress section when no progress object', () => {
        const item = createMockQueueItem({ status: 'running' });
        const treeItem = new QueueTreeItem(item);

        expect(getTooltipValue(treeItem)).not.toContain('### Progress');
      });

      it('should show progress in tooltip for any status with phaseProgress', () => {
        // Tooltip shows progress regardless of status (unlike description which only shows for running)
        const item = createMockQueueItem({
          status: 'completed',
          startedAt: '2026-02-23T10:00:00.000Z',
          completedAt: '2026-02-23T10:05:00.000Z',
        });
        const progress = createProgressSummary({
          phaseProgress: 'Phase 8/8',
          currentPhase: undefined,
        });
        const treeItem = new QueueTreeItem(item, progress);

        expect(getTooltipValue(treeItem)).toContain('### Progress');
        expect(getTooltipValue(treeItem)).toContain('Phase 8/8');
      });
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

  it('should set unique ID', () => {
    const item = new QueueFilterGroupItem('Running', 'status', 'running', 3);
    expect(item.id).toBe('filter-status-running');
  });

  describe('filter icons', () => {
    it('should use status icon for status filter', () => {
      const item = new QueueFilterGroupItem('Running', 'status', 'running', 3);
      expect((item.iconPath as { id: string }).id).toBe('sync~spin');
    });

    it('should use repo icon for repository filter', () => {
      const item = new QueueFilterGroupItem('org/repo', 'repository', 'org/repo', 2);
      expect((item.iconPath as { id: string }).id).toBe('repo');
    });

    it('should use person icon for assignee filter', () => {
      const item = new QueueFilterGroupItem('User', 'assignee', 'user-1', 1);
      expect((item.iconPath as { id: string }).id).toBe('person');
    });
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

    it('should have info icon', () => {
      const item = new QueueEmptyItem('Empty');
      expect((item.iconPath as { id: string }).id).toBe('info');
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

    it('should have red error icon color', () => {
      const item = new QueueErrorItem(new Error('Test'));
      expect((item.iconPath as { color?: { id: string } }).color?.id).toBe('charts.red');
    });

    it('should have retry command', () => {
      const item = new QueueErrorItem(new Error('Test'));
      expect(item.command?.command).toBe('generacy.queue.refresh');
    });

    it('should have retry description', () => {
      const item = new QueueErrorItem(new Error('Test'));
      expect(item.description).toBe('Click to retry');
    });

    it('should include error message in tooltip', () => {
      const item = new QueueErrorItem(new Error('Connection refused'));
      expect((item.tooltip as { value: string }).value).toContain('Connection refused');
    });
  });
});

describe('Type guards', () => {
  describe('isQueueTreeItem', () => {
    it('should return true for QueueTreeItem', () => {
      const item = new QueueTreeItem(createMockQueueItem());
      expect(isQueueTreeItem(item)).toBe(true);
    });

    it('should return true for all statuses', () => {
      const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
      for (const status of statuses) {
        const item = new QueueTreeItem(createMockQueueItem({ status }));
        expect(isQueueTreeItem(item)).toBe(true);
      }
    });

    it('should return false for other items', () => {
      const item = new QueueEmptyItem('Empty');
      expect(isQueueTreeItem(item)).toBe(false);
    });

    it('should return false for filter group items', () => {
      const item = new QueueFilterGroupItem('Test', 'status', 'pending', 5);
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

    it('should return false for empty items', () => {
      const item = new QueueEmptyItem('Empty');
      expect(isQueueFilterGroupItem(item)).toBe(false);
    });
  });
});
