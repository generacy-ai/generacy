/**
 * Tests for integration tree items
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Integration, IntegrationType, IntegrationStatus } from '../../../../api/types';

// Mock vscode module
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
}));

// Import after mocking
import {
  IntegrationTreeItem,
  IntegrationTypeGroupItem,
  IntegrationEmptyItem,
  IntegrationLoadingItem,
  IntegrationErrorItem,
  RepositoryTreeItem,
  WebhookTreeItem,
  WebhookSectionItem,
  isIntegrationTreeItem,
  isIntegrationTypeGroupItem,
} from '../tree-item';

describe('IntegrationTreeItem', () => {
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

  describe('constructor', () => {
    it('should create a tree item with correct label for connected integration', () => {
      const integration = createIntegration('github', 'connected', 'octocat');
      const item = new IntegrationTreeItem(integration);

      expect(item.label).toBe('GitHub');
      expect(item.integration).toBe(integration);
    });

    it('should create a tree item with correct label for disconnected integration', () => {
      const integration = createIntegration('gitlab', 'disconnected');
      const item = new IntegrationTreeItem(integration);

      expect(item.label).toBe('GitLab');
    });

    it('should create a tree item with correct label for error integration', () => {
      const integration = createIntegration('bitbucket', 'error');
      const item = new IntegrationTreeItem(integration);

      expect(item.label).toBe('Bitbucket');
    });

    it('should set collapsible state for connected integrations', () => {
      const connected = createIntegration('github', 'connected');
      const disconnected = createIntegration('github', 'disconnected');

      const connectedItem = new IntegrationTreeItem(connected);
      const disconnectedItem = new IntegrationTreeItem(disconnected);

      // Connected integrations should be collapsible (have children like repos)
      expect(connectedItem.collapsibleState).toBe(1); // Collapsed
      expect(disconnectedItem.collapsibleState).toBe(0); // None
    });

    it('should set context value based on type and status', () => {
      const integration = createIntegration('github', 'connected');
      const item = new IntegrationTreeItem(integration);

      expect(item.contextValue).toBe('integration-github-connected');
    });

    it('should set unique ID', () => {
      const integration = createIntegration('github', 'connected');
      const item = new IntegrationTreeItem(integration);

      expect(item.id).toBe('integration-github');
    });

    it('should include account name in description', () => {
      const integration = createIntegration('github', 'connected', 'octocat');
      const item = new IntegrationTreeItem(integration);

      expect(item.description).toContain('octocat');
    });

    it('should show "Not connected" for disconnected integrations', () => {
      const integration = createIntegration('github', 'disconnected');
      const item = new IntegrationTreeItem(integration);

      expect(item.description).toContain('Not connected');
    });

    it('should set command for disconnected integrations', () => {
      const integration = createIntegration('github', 'disconnected');
      const item = new IntegrationTreeItem(integration);

      expect(item.command).toEqual({
        command: 'generacy.integrations.connect',
        title: 'Connect',
        arguments: ['github'],
      });
    });

    it('should not set command for connected integrations', () => {
      const integration = createIntegration('github', 'connected');
      const item = new IntegrationTreeItem(integration);

      expect(item.command).toBeUndefined();
    });
  });
});

describe('IntegrationTypeGroupItem', () => {
  it('should create a group item with correct label', () => {
    const integrations: Integration[] = [
      { type: 'github', status: 'connected' },
      { type: 'github', status: 'disconnected' },
    ];
    const item = new IntegrationTypeGroupItem('github', integrations);

    expect(item.label).toBe('GitHub');
  });

  it('should show correct count in description', () => {
    const integrations: Integration[] = [
      { type: 'github', status: 'connected' },
      { type: 'github', status: 'disconnected' },
    ];
    const item = new IntegrationTypeGroupItem('github', integrations);

    expect(item.description).toBe('(1/2 connected)');
  });

  it('should be expanded by default', () => {
    const integrations: Integration[] = [{ type: 'github', status: 'connected' }];
    const item = new IntegrationTypeGroupItem('github', integrations);

    expect(item.collapsibleState).toBe(2); // Expanded
  });

  it('should set context value with type', () => {
    const integrations: Integration[] = [{ type: 'gitlab', status: 'connected' }];
    const item = new IntegrationTypeGroupItem('gitlab', integrations);

    expect(item.contextValue).toBe('integrationGroup-gitlab');
  });
});

describe('IntegrationEmptyItem', () => {
  it('should create empty item with default message', () => {
    const item = new IntegrationEmptyItem();

    expect(item.label).toBe('No integrations configured');
  });

  it('should create empty item with custom message', () => {
    const item = new IntegrationEmptyItem('Custom message');

    expect(item.label).toBe('Custom message');
  });

  it('should not be collapsible', () => {
    const item = new IntegrationEmptyItem();

    expect(item.collapsibleState).toBe(0); // None
  });

  it('should have correct context value', () => {
    const item = new IntegrationEmptyItem();

    expect(item.contextValue).toBe('integrationEmpty');
  });
});

describe('IntegrationLoadingItem', () => {
  it('should create loading item with correct label', () => {
    const item = new IntegrationLoadingItem();

    expect(item.label).toBe('Loading integrations...');
  });

  it('should have correct context value', () => {
    const item = new IntegrationLoadingItem();

    expect(item.contextValue).toBe('integrationLoading');
  });
});

describe('IntegrationErrorItem', () => {
  it('should create error item with correct label', () => {
    const error = new Error('Test error');
    const item = new IntegrationErrorItem(error);

    expect(item.label).toBe('Failed to load integrations');
    expect(item.error).toBe(error);
  });

  it('should have retry command', () => {
    const item = new IntegrationErrorItem(new Error('Test'));

    expect(item.command).toEqual({
      command: 'generacy.integrations.refresh',
      title: 'Retry',
    });
  });

  it('should have correct context value', () => {
    const item = new IntegrationErrorItem(new Error('Test'));

    expect(item.contextValue).toBe('integrationError');
  });
});

describe('RepositoryTreeItem', () => {
  it('should create repository item with correct label', () => {
    const item = new RepositoryTreeItem('owner/repo', false);

    expect(item.label).toBe('owner/repo');
    expect(item.repositoryFullName).toBe('owner/repo');
  });

  it('should show lock icon for private repos', () => {
    const privateItem = new RepositoryTreeItem('owner/private-repo', true);
    const publicItem = new RepositoryTreeItem('owner/public-repo', false);

    expect(privateItem.isPrivate).toBe(true);
    expect(publicItem.isPrivate).toBe(false);
    expect((privateItem.iconPath as any).id).toBe('lock');
    expect((publicItem.iconPath as any).id).toBe('repo');
  });

  it('should have correct context value', () => {
    const item = new RepositoryTreeItem('owner/repo', false);

    expect(item.contextValue).toBe('integrationRepository');
  });
});

describe('WebhookTreeItem', () => {
  it('should create webhook item with shortened URL', () => {
    const item = new WebhookTreeItem(
      'webhook-1',
      'https://example.com/webhooks/receive',
      ['push', 'pull_request'],
      true,
      'github'
    );

    expect(item.label).toBe('example.com/webhooks/receive');
    expect(item.webhookId).toBe('webhook-1');
  });

  it('should show event count in description', () => {
    const item = new WebhookTreeItem(
      'webhook-1',
      'https://example.com/webhook',
      ['push', 'pull_request', 'issues'],
      true,
      'github'
    );

    expect(item.description).toBe('3 events');
  });

  it('should indicate disabled state', () => {
    const item = new WebhookTreeItem(
      'webhook-1',
      'https://example.com/webhook',
      ['push'],
      false,
      'github'
    );

    expect(item.description).toContain('disabled');
    expect(item.contextValue).toBe('webhook-inactive');
  });

  it('should have correct context value for active webhook', () => {
    const item = new WebhookTreeItem(
      'webhook-1',
      'https://example.com/webhook',
      ['push'],
      true,
      'github'
    );

    expect(item.contextValue).toBe('webhook-active');
  });
});

describe('WebhookSectionItem', () => {
  it('should create section item with correct label', () => {
    const item = new WebhookSectionItem('github', 3);

    expect(item.label).toBe('Webhooks');
  });

  it('should show webhook count in description', () => {
    const item = new WebhookSectionItem('github', 5);

    expect(item.description).toBe('(5)');
  });

  it('should be collapsible', () => {
    const item = new WebhookSectionItem('github', 2);

    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it('should have correct context value', () => {
    const item = new WebhookSectionItem('github', 1);

    expect(item.contextValue).toBe('webhookSection');
  });
});

describe('Type guards', () => {
  describe('isIntegrationTreeItem', () => {
    it('should return true for IntegrationTreeItem', () => {
      const integration = { type: 'github' as IntegrationType, status: 'connected' as IntegrationStatus };
      const item = new IntegrationTreeItem(integration);

      expect(isIntegrationTreeItem(item)).toBe(true);
    });

    it('should return false for other items', () => {
      const item = new IntegrationEmptyItem();

      expect(isIntegrationTreeItem(item)).toBe(false);
    });
  });

  describe('isIntegrationTypeGroupItem', () => {
    it('should return true for IntegrationTypeGroupItem', () => {
      const integrations = [{ type: 'github' as IntegrationType, status: 'connected' as IntegrationStatus }];
      const item = new IntegrationTypeGroupItem('github', integrations);

      expect(isIntegrationTypeGroupItem(item)).toBe(true);
    });

    it('should return false for other items', () => {
      const integration = { type: 'github' as IntegrationType, status: 'connected' as IntegrationStatus };
      const item = new IntegrationTreeItem(integration);

      expect(isIntegrationTypeGroupItem(item)).toBe(false);
    });
  });
});
