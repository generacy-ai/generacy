/**
 * Tests for IntegrationsTreeProvider
 */
import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';

// Mock dependencies before imports
const mockGetLogger = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockAuthService = {
  isAuthenticated: vi.fn(() => true),
  onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
};

const mockGetAuthService = vi.fn(() => mockAuthService);

const mockIntegrationsApi = {
  getIntegrations: vi.fn(),
  getIntegrationDetails: vi.fn(),
  getWebhooks: vi.fn(),
};

// Mock modules
vi.mock('../../../../utils/logger', () => ({
  getLogger: mockGetLogger,
}));

vi.mock('../../../../api/auth', () => ({
  getAuthService: mockGetAuthService,
}));

vi.mock('../../../../api/endpoints/integrations', () => ({
  integrationsApi: mockIntegrationsApi,
}));

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
    private content = '';
    appendMarkdown(text: string) {
      this.content += text;
      return this;
    }
    toString() {
      return this.content;
    }
  },
  EventEmitter: class {
    private listeners: ((...args: unknown[]) => void)[] = [];
    event = (listener: (...args: unknown[]) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire = (data?: unknown) => {
      this.listeners.forEach((l) => l(data));
    };
    dispose = vi.fn();
  },
  window: {
    createTreeView: vi.fn(() => ({
      onDidChangeVisibility: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

// Import after mocking
import { IntegrationsTreeProvider } from '../provider';
import {
  IntegrationEmptyItem,
  IntegrationLoadingItem,
  IntegrationErrorItem,
  IntegrationTreeItem,
} from '../tree-item';
import type { Integration, IntegrationType, IntegrationStatus } from '../../../../api/types';

describe('IntegrationsTreeProvider', () => {
  let provider: IntegrationsTreeProvider;

  const createIntegration = (
    type: IntegrationType = 'github',
    status: IntegrationStatus = 'connected',
    accountName?: string
  ): Integration => ({
    type,
    status,
    accountName,
    connectedAt: status === 'connected' ? '2024-01-15T10:30:00Z' : undefined,
    error: status === 'error' ? 'Connection failed' : undefined,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset mocks to default values
    mockAuthService.isAuthenticated.mockReturnValue(true);
    mockIntegrationsApi.getIntegrations.mockResolvedValue([]);
    mockIntegrationsApi.getIntegrationDetails.mockResolvedValue({
      type: 'github',
      status: 'connected',
    });
    mockIntegrationsApi.getWebhooks.mockResolvedValue([]);
  });

  afterEach(() => {
    provider?.dispose();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create provider with default options', () => {
      provider = new IntegrationsTreeProvider();

      expect(provider).toBeDefined();
      expect(provider.getViewMode()).toBe('flat');
    });

    it('should create provider with custom options', () => {
      provider = new IntegrationsTreeProvider({
        pollingInterval: 30000,
        viewMode: 'byType',
      });

      expect(provider.getViewMode()).toBe('byType');
    });

    it('should start polling when authenticated', () => {
      mockAuthService.isAuthenticated.mockReturnValue(true);

      provider = new IntegrationsTreeProvider();

      // Run timers to trigger the immediate fetch
      vi.runAllTimers();

      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalled();
    });

    it('should not start polling when not authenticated', () => {
      mockAuthService.isAuthenticated.mockReturnValue(false);

      provider = new IntegrationsTreeProvider();

      vi.runAllTimers();

      expect(mockIntegrationsApi.getIntegrations).not.toHaveBeenCalled();
    });
  });

  describe('getTreeItem', () => {
    it('should return the element as-is', () => {
      provider = new IntegrationsTreeProvider();
      const item = new IntegrationEmptyItem();

      const result = provider.getTreeItem(item);

      expect(result).toBe(item);
    });
  });

  describe('getChildren', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should return empty item when not authenticated', async () => {
      mockAuthService.isAuthenticated.mockReturnValue(false);

      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(IntegrationEmptyItem);
      expect(children[0].label).toBe('Sign in to view integrations');
    });

    it('should return empty item when no integrations', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      // Trigger fetch
      provider.refresh();
      await vi.runAllTimersAsync();

      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(IntegrationEmptyItem);
    });

    it('should return integration items in flat mode', async () => {
      const integrations = [
        createIntegration('github', 'connected', 'octocat'),
        createIntegration('gitlab', 'disconnected'),
      ];
      mockIntegrationsApi.getIntegrations.mockResolvedValue(integrations);

      // Trigger fetch
      provider.refresh();
      await vi.runAllTimersAsync();

      const children = await provider.getChildren();

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(IntegrationTreeItem);
      expect(children[1]).toBeInstanceOf(IntegrationTreeItem);
    });
  });

  describe('setViewMode', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should change view mode', () => {
      expect(provider.getViewMode()).toBe('flat');

      provider.setViewMode('byType');

      expect(provider.getViewMode()).toBe('byType');
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should trigger a fetch', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      provider.refresh();
      await vi.runAllTimersAsync();

      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalled();
    });
  });

  describe('getIntegrationByType', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should return integration by type', async () => {
      const github = createIntegration('github', 'connected');
      mockIntegrationsApi.getIntegrations.mockResolvedValue([github]);

      provider.refresh();
      await vi.runAllTimersAsync();

      const result = provider.getIntegrationByType('github');

      expect(result).toEqual(github);
    });

    it('should return undefined for non-existent type', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      provider.refresh();
      await vi.runAllTimersAsync();

      const result = provider.getIntegrationByType('gitlab');

      expect(result).toBeUndefined();
    });
  });

  describe('getAllIntegrations', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should return all integrations', async () => {
      const integrations = [
        createIntegration('github', 'connected'),
        createIntegration('gitlab', 'disconnected'),
      ];
      mockIntegrationsApi.getIntegrations.mockResolvedValue(integrations);

      provider.refresh();
      await vi.runAllTimersAsync();

      const result = provider.getAllIntegrations();

      expect(result).toHaveLength(2);
      expect(result).not.toBe(integrations); // Should be a copy
    });
  });

  describe('getConnectedIntegrations', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider();
    });

    it('should return only connected integrations', async () => {
      const integrations = [
        createIntegration('github', 'connected'),
        createIntegration('gitlab', 'disconnected'),
        createIntegration('bitbucket', 'connected'),
      ];
      mockIntegrationsApi.getIntegrations.mockResolvedValue(integrations);

      provider.refresh();
      await vi.runAllTimersAsync();

      const result = provider.getConnectedIntegrations();

      expect(result).toHaveLength(2);
      expect(result.every((i) => i.status === 'connected')).toBe(true);
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      provider = new IntegrationsTreeProvider({ pollingInterval: 1000 });
    });

    it('should poll at specified interval', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      // Initial fetch on construction
      await vi.runAllTimersAsync();
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1);

      // Advance timer by polling interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(2);

      // Another interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(3);
    });

    it('should pause polling', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      // Initial fetch
      await vi.runAllTimersAsync();
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1);

      // Pause
      provider.pausePolling();

      // Advance timer
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should resume polling', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      // Initial fetch
      await vi.runAllTimersAsync();
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1);

      // Pause and resume
      provider.pausePolling();
      provider.resumePolling();

      // Resume triggers immediate fetch
      await vi.runAllTimersAsync();
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(2);
    });

    it('should stop polling on dispose', async () => {
      mockIntegrationsApi.getIntegrations.mockResolvedValue([]);

      // Initial fetch
      await vi.runAllTimersAsync();
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1);

      // Dispose
      provider.dispose();

      // Advance timer
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockIntegrationsApi.getIntegrations).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      provider = new IntegrationsTreeProvider();

      provider.dispose();

      // Should not throw and should clear data
      expect(provider.getAllIntegrations()).toHaveLength(0);
    });
  });
});
