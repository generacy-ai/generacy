/**
 * Integration configuration panel.
 * Provides configuration UI, repository selection, and webhook management.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import {
  integrationsApi,
  IntegrationDetails,
  Webhook,
  CreateWebhookRequest,
} from '../../../api/endpoints/integrations';
import { IntegrationType } from '../../../api/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration option
 */
interface ConfigOption {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'string' | 'select';
  options?: { label: string; value: string }[];
  currentValue?: unknown;
}

/**
 * Available webhook events
 */
const WEBHOOK_EVENTS: Record<IntegrationType, { event: string; description: string }[]> = {
  github: [
    { event: 'push', description: 'Code pushes to repository' },
    { event: 'pull_request', description: 'Pull request opened, closed, or merged' },
    { event: 'issues', description: 'Issue created, edited, or closed' },
    { event: 'issue_comment', description: 'Comment on issue or PR' },
    { event: 'workflow_run', description: 'GitHub Actions workflow run' },
    { event: 'release', description: 'Release published' },
  ],
  gitlab: [
    { event: 'push', description: 'Code pushes to repository' },
    { event: 'merge_request', description: 'Merge request events' },
    { event: 'issue', description: 'Issue events' },
    { event: 'note', description: 'Comment events' },
    { event: 'pipeline', description: 'Pipeline events' },
  ],
  bitbucket: [
    { event: 'push', description: 'Code pushes' },
    { event: 'pullrequest', description: 'Pull request events' },
    { event: 'issue', description: 'Issue events' },
  ],
  jira: [
    { event: 'issue_created', description: 'Issue created' },
    { event: 'issue_updated', description: 'Issue updated' },
    { event: 'issue_deleted', description: 'Issue deleted' },
    { event: 'comment_created', description: 'Comment added' },
  ],
  linear: [
    { event: 'issue', description: 'Issue events' },
    { event: 'comment', description: 'Comment events' },
    { event: 'project', description: 'Project events' },
  ],
};

// ============================================================================
// Configuration Panel
// ============================================================================

/**
 * IntegrationConfigPanel provides configuration UI for integrations.
 */
export class IntegrationConfigPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const logger = getLogger();
    logger.debug('IntegrationConfigPanel initialized');
  }

  /**
   * Show configuration panel for an integration
   */
  public async showConfigPanel(type: IntegrationType): Promise<void> {
    const logger = getLogger();
    logger.info(`Showing config panel for ${type}`);

    try {
      const details = await integrationsApi.getIntegrationDetails(type);

      if (details.status !== 'connected') {
        vscode.window.showWarningMessage(
          `${this.getTypeName(type)} is not connected. Connect it first to configure.`
        );
        return;
      }

      await this.showMainConfigMenu(type, details);
    } catch (error) {
      logger.error(`Failed to load config for ${type}`, error);
      vscode.window.showErrorMessage(
        `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Show main configuration menu
   */
  private async showMainConfigMenu(
    type: IntegrationType,
    details: IntegrationDetails
  ): Promise<void> {
    const webhooks = await integrationsApi.getWebhooks(type);

    const items: vscode.QuickPickItem[] = [
      {
        label: '$(settings-gear) General Settings',
        description: 'Configure integration options',
      },
      {
        label: '$(link) Webhooks',
        description: `${webhooks.length} configured`,
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
    ];

    // Add type-specific options
    if (type === 'github' && details.github) {
      items.splice(1, 0, {
        label: '$(repo) Repositories',
        description: `${details.github.repositories.length} connected`,
      });
    }

    items.push({
      label: '$(refresh) Refresh Status',
      description: 'Check connection status',
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: `Configure ${this.getTypeName(type)}`,
      placeHolder: 'Select configuration option',
    });

    if (!selected) {
      return;
    }

    if (selected.label.includes('General Settings')) {
      await this.showGeneralSettings(type, details);
    } else if (selected.label.includes('Repositories')) {
      await this.showRepositoryConfig(type, details);
    } else if (selected.label.includes('Webhooks')) {
      await this.showWebhookConfig(type);
    } else if (selected.label.includes('Refresh')) {
      await this.refreshStatus(type);
    }
  }

  /**
   * Show general settings
   */
  private async showGeneralSettings(
    type: IntegrationType,
    details: IntegrationDetails
  ): Promise<void> {
    const logger = getLogger();
    logger.info(`Showing general settings for ${type}`);

    const config = details.config ?? {};

    // Build configuration options based on type
    const options = this.getConfigOptions(type, config);

    if (options.length === 0) {
      vscode.window.showInformationMessage(
        `No configurable settings available for ${this.getTypeName(type)}.`
      );
      return;
    }

    const items = options.map((opt) => ({
      label: opt.label,
      description: this.formatConfigValue(opt),
      option: opt,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `${this.getTypeName(type)} Settings`,
      placeHolder: 'Select setting to modify',
    });

    if (!selected) {
      return;
    }

    await this.editConfigOption(type, selected.option);
  }

  /**
   * Get configuration options for integration type
   */
  private getConfigOptions(type: IntegrationType, config: Record<string, unknown>): ConfigOption[] {
    const baseOptions: ConfigOption[] = [
      {
        key: 'autoSync',
        label: 'Auto-Sync',
        description: 'Automatically sync workflows on changes',
        type: 'boolean',
        currentValue: config['autoSync'] ?? false,
      },
      {
        key: 'notifyOnError',
        label: 'Error Notifications',
        description: 'Show notifications on integration errors',
        type: 'boolean',
        currentValue: config['notifyOnError'] ?? true,
      },
    ];

    // Add type-specific options
    if (type === 'github') {
      baseOptions.push({
        key: 'defaultBranch',
        label: 'Default Branch',
        description: 'Default branch for operations',
        type: 'string',
        currentValue: config['defaultBranch'] ?? 'main',
      });
    }

    return baseOptions;
  }

  /**
   * Format configuration value for display
   */
  private formatConfigValue(option: ConfigOption): string {
    if (option.type === 'boolean') {
      return option.currentValue ? '$(check) Enabled' : '$(circle-slash) Disabled';
    }
    return String(option.currentValue ?? 'Not set');
  }

  /**
   * Edit a configuration option
   */
  private async editConfigOption(type: IntegrationType, option: ConfigOption): Promise<void> {
    const logger = getLogger();
    let newValue: unknown;

    if (option.type === 'boolean') {
      const selected = await vscode.window.showQuickPick(
        [
          { label: '$(check) Enable', value: true },
          { label: '$(circle-slash) Disable', value: false },
        ],
        { title: option.label, placeHolder: option.description }
      );

      if (!selected) {
        return;
      }

      newValue = selected.value;
    } else if (option.type === 'string') {
      newValue = await vscode.window.showInputBox({
        title: option.label,
        prompt: option.description,
        value: String(option.currentValue ?? ''),
      });

      if (newValue === undefined) {
        return;
      }
    } else if (option.type === 'select' && option.options) {
      const selected = await vscode.window.showQuickPick(
        option.options.map((o) => ({ label: o.label, value: o.value })),
        { title: option.label, placeHolder: option.description }
      );

      if (!selected) {
        return;
      }

      newValue = selected.value;
    }

    try {
      await integrationsApi.updateIntegrationConfig(type, { [option.key]: newValue });
      vscode.window.showInformationMessage(`${option.label} updated successfully.`);
    } catch (error) {
      logger.error(`Failed to update config ${option.key}`, error);
      vscode.window.showErrorMessage(
        `Failed to update setting: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Show repository configuration
   */
  private async showRepositoryConfig(
    type: IntegrationType,
    details: IntegrationDetails
  ): Promise<void> {
    const logger = getLogger();
    logger.info(`Showing repository config for ${type}`);

    if (type !== 'github' || !details.github) {
      vscode.window.showInformationMessage('Repository configuration is only available for GitHub.');
      return;
    }

    const github = details.github;
    const repos = github.repositories;

    if (repos.length === 0) {
      const action = await vscode.window.showInformationMessage(
        'No repositories connected. Add repositories in GitHub App settings.',
        'Open GitHub Settings'
      );

      if (action === 'Open GitHub Settings') {
        await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
      }
      return;
    }

    const items = repos.map((repo) => ({
      label: `${repo.isPrivate ? '$(lock)' : '$(repo)'} ${repo.fullName}`,
      description: repo.isPrivate ? 'Private' : 'Public',
      repo,
    }));

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
      {
        label: '$(link-external) Manage in GitHub',
        description: 'Add or remove repository access',
        repo: null,
      } as any
    );

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Connected Repositories',
      placeHolder: `${repos.length} repositories connected`,
    });

    if (!selected) {
      return;
    }

    if (!selected.repo) {
      await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
    }
  }

  /**
   * Refresh integration status
   */
  private async refreshStatus(type: IntegrationType): Promise<void> {
    const logger = getLogger();
    logger.info(`Refreshing status for ${type}`);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checking ${this.getTypeName(type)} status...`,
        },
        async () => {
          const status = await integrationsApi.getIntegrationStatus(type);
          vscode.window.showInformationMessage(
            `${this.getTypeName(type)} status: ${status}`
          );
        }
      );
    } catch (error) {
      logger.error(`Failed to refresh status for ${type}`, error);
      vscode.window.showErrorMessage(
        `Failed to check status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ==========================================================================
  // Webhook Configuration
  // ==========================================================================

  /**
   * Show webhook configuration
   */
  public async showWebhookConfig(type: IntegrationType): Promise<void> {
    const logger = getLogger();
    logger.info(`Showing webhook config for ${type}`);

    try {
      const webhooks = await integrationsApi.getWebhooks(type);

      const items: vscode.QuickPickItem[] = [
        {
          label: '$(add) Create Webhook',
          description: 'Add a new webhook',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
      ];

      if (webhooks.length === 0) {
        items.push({
          label: '$(info) No webhooks configured',
          description: 'Create one to receive events',
        });
      } else {
        for (const webhook of webhooks) {
          const urlObj = new URL(webhook.url);
          items.push({
            label: `${webhook.active ? '$(check)' : '$(circle-slash)'} ${urlObj.hostname}${urlObj.pathname}`,
            description: `${webhook.events.length} events${webhook.active ? '' : ' (disabled)'}`,
            detail: webhook.id,
          });
        }
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: `${this.getTypeName(type)} Webhooks`,
        placeHolder: 'Select webhook to manage or create new',
      });

      if (!selected) {
        return;
      }

      if (selected.label.includes('Create Webhook')) {
        await this.createWebhook(type);
      } else if (selected.detail) {
        const webhook = webhooks.find((w) => w.id === selected.detail);
        if (webhook) {
          await this.manageWebhook(type, webhook);
        }
      }
    } catch (error) {
      logger.error(`Failed to load webhooks for ${type}`, error);
      vscode.window.showErrorMessage(
        `Failed to load webhooks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create a new webhook
   */
  private async createWebhook(type: IntegrationType): Promise<void> {
    const logger = getLogger();
    logger.info(`Creating webhook for ${type}`);

    // Get URL
    const url = await vscode.window.showInputBox({
      title: 'Webhook URL',
      prompt: 'Enter the URL to receive webhook events',
      placeHolder: 'https://example.com/webhook',
      validateInput: (value) => {
        try {
          new URL(value);
          return null;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });

    if (!url) {
      return;
    }

    // Select events
    const availableEvents = WEBHOOK_EVENTS[type] ?? [];
    const eventItems = availableEvents.map((e) => ({
      label: e.event,
      description: e.description,
      picked: false,
    }));

    const selectedEvents = await vscode.window.showQuickPick(eventItems, {
      title: 'Select Events',
      placeHolder: 'Choose events to subscribe to',
      canPickMany: true,
    });

    if (!selectedEvents || selectedEvents.length === 0) {
      return;
    }

    // Optional secret
    const secret = await vscode.window.showInputBox({
      title: 'Webhook Secret (Optional)',
      prompt: 'Enter a secret for payload signing (leave empty to skip)',
      password: true,
    });

    try {
      const request: CreateWebhookRequest = {
        url,
        events: selectedEvents.map((e) => e.label),
        secret: secret || undefined,
      };

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating webhook...',
        },
        async () => {
          await integrationsApi.createWebhook(type, request);
        }
      );

      vscode.window.showInformationMessage('Webhook created successfully.');
    } catch (error) {
      logger.error('Failed to create webhook', error);
      vscode.window.showErrorMessage(
        `Failed to create webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Manage an existing webhook
   */
  private async manageWebhook(type: IntegrationType, webhook: Webhook): Promise<void> {
    const logger = getLogger();
    logger.info(`Managing webhook ${webhook.id}`);

    const items: vscode.QuickPickItem[] = [
      {
        label: '$(info) Webhook Details',
        description: 'View webhook configuration',
      },
      {
        label: webhook.active ? '$(circle-slash) Disable' : '$(check) Enable',
        description: webhook.active ? 'Temporarily disable webhook' : 'Re-enable webhook',
      },
      {
        label: '$(beaker) Test Webhook',
        description: 'Send a test payload',
      },
      {
        label: '$(history) Last Delivery',
        description: webhook.lastDeliveryStatus
          ? `${webhook.lastDeliveryStatus === 'success' ? '✓' : '✗'} ${webhook.lastDeliveryAt ?? ''}`
          : 'No deliveries yet',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(trash) Delete Webhook',
        description: 'Permanently remove this webhook',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Manage Webhook',
      placeHolder: new URL(webhook.url).hostname,
    });

    if (!selected) {
      return;
    }

    if (selected.label.includes('Details')) {
      await this.showWebhookDetails(webhook);
    } else if (selected.label.includes('Disable') || selected.label.includes('Enable')) {
      await this.toggleWebhook(type, webhook);
    } else if (selected.label.includes('Test')) {
      await this.testWebhook(type, webhook);
    } else if (selected.label.includes('Delete')) {
      await this.deleteWebhook(type, webhook);
    }
  }

  /**
   * Show webhook details
   */
  private async showWebhookDetails(webhook: Webhook): Promise<void> {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`## Webhook Details\n\n`);
    md.appendMarkdown(`**URL:** \`${webhook.url}\`\n\n`);
    md.appendMarkdown(`**Status:** ${webhook.active ? '✓ Active' : '○ Disabled'}\n\n`);
    md.appendMarkdown(`**Events:**\n`);
    for (const event of webhook.events) {
      md.appendMarkdown(`- ${event}\n`);
    }
    md.appendMarkdown(`\n**Created:** ${new Date(webhook.createdAt).toLocaleString()}\n`);

    if (webhook.lastDeliveryAt) {
      md.appendMarkdown(
        `\n**Last Delivery:** ${new Date(webhook.lastDeliveryAt).toLocaleString()} (${webhook.lastDeliveryStatus})\n`
      );
    }

    // Show in output channel since markdown in showInformationMessage is limited
    const channel = vscode.window.createOutputChannel('Generacy - Webhook Details');
    channel.clear();
    channel.appendLine('Webhook Details');
    channel.appendLine('===============');
    channel.appendLine(`URL: ${webhook.url}`);
    channel.appendLine(`Status: ${webhook.active ? 'Active' : 'Disabled'}`);
    channel.appendLine(`Events: ${webhook.events.join(', ')}`);
    channel.appendLine(`Created: ${new Date(webhook.createdAt).toLocaleString()}`);
    if (webhook.lastDeliveryAt) {
      channel.appendLine(
        `Last Delivery: ${new Date(webhook.lastDeliveryAt).toLocaleString()} (${webhook.lastDeliveryStatus})`
      );
    }
    channel.show();
  }

  /**
   * Toggle webhook active state
   */
  private async toggleWebhook(type: IntegrationType, webhook: Webhook): Promise<void> {
    const logger = getLogger();
    const newState = !webhook.active;
    logger.info(`Toggling webhook ${webhook.id} to ${newState}`);

    try {
      await integrationsApi.toggleWebhook(type, webhook.id, newState);
      vscode.window.showInformationMessage(
        `Webhook ${newState ? 'enabled' : 'disabled'} successfully.`
      );
    } catch (error) {
      logger.error('Failed to toggle webhook', error);
      vscode.window.showErrorMessage(
        `Failed to ${newState ? 'enable' : 'disable'} webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Test webhook with a test payload
   */
  private async testWebhook(type: IntegrationType, webhook: Webhook): Promise<void> {
    const logger = getLogger();
    logger.info(`Testing webhook ${webhook.id}`);

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Sending test payload...',
        },
        async () => {
          return await integrationsApi.testWebhook(type, webhook.id);
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(
          `Webhook test successful! Status: ${result.statusCode}`
        );
      } else {
        vscode.window.showWarningMessage(
          `Webhook test failed: ${result.error ?? 'Unknown error'}. Status: ${result.statusCode ?? 'N/A'}`
        );
      }
    } catch (error) {
      logger.error('Failed to test webhook', error);
      vscode.window.showErrorMessage(
        `Failed to test webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Delete a webhook
   */
  private async deleteWebhook(type: IntegrationType, webhook: Webhook): Promise<void> {
    const logger = getLogger();
    logger.info(`Deleting webhook ${webhook.id}`);

    const confirmed = await vscode.window.showWarningMessage(
      'Are you sure you want to delete this webhook? This action cannot be undone.',
      { modal: true },
      'Delete'
    );

    if (confirmed !== 'Delete') {
      return;
    }

    try {
      await integrationsApi.deleteWebhook(type, webhook.id);
      vscode.window.showInformationMessage('Webhook deleted successfully.');
    } catch (error) {
      logger.error('Failed to delete webhook', error);
      vscode.window.showErrorMessage(
        `Failed to delete webhook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Get type display name
   */
  private getTypeName(type: IntegrationType): string {
    const names: Record<IntegrationType, string> = {
      github: 'GitHub',
      gitlab: 'GitLab',
      bitbucket: 'Bitbucket',
      jira: 'Jira',
      linear: 'Linear',
    };
    return names[type] || type;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Create and register the integration config panel
 */
export function createIntegrationConfigPanel(
  context: vscode.ExtensionContext
): IntegrationConfigPanel {
  const panel = new IntegrationConfigPanel();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.integrations.configure',
      async (type?: IntegrationType) => {
        if (!type) {
          // Show quick pick for type
          const selected = await vscode.window.showQuickPick(
            [
              { label: '$(github) GitHub', type: 'github' as IntegrationType },
              { label: '$(git-merge) GitLab', type: 'gitlab' as IntegrationType },
              { label: '$(git-branch) Bitbucket', type: 'bitbucket' as IntegrationType },
              { label: '$(issues) Jira', type: 'jira' as IntegrationType },
              { label: '$(checklist) Linear', type: 'linear' as IntegrationType },
            ],
            { placeHolder: 'Select integration to configure' }
          );

          if (!selected) {
            return;
          }

          type = selected.type;
        }

        await panel.showConfigPanel(type);
      }
    ),
    vscode.commands.registerCommand(
      'generacy.integrations.webhooks',
      async (type?: IntegrationType) => {
        if (!type) {
          type = 'github';
        }
        await panel.showWebhookConfig(type);
      }
    )
  );

  context.subscriptions.push(panel);

  return panel;
}
