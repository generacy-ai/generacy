/**
 * GitHub integration view components.
 * Provides GitHub App-specific display and actions.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import {
  integrationsApi,
  GitHubInstallation,
  IntegrationDetails,
} from '../../../api/endpoints/integrations';

// ============================================================================
// Constants
// ============================================================================

/** GitHub App installation URL template */
const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/generacy-ai/installations/new';

/** GitHub permission scopes with descriptions */
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'contents:read': 'Read repository contents',
  'contents:write': 'Read and write repository contents',
  'issues:read': 'Read issues',
  'issues:write': 'Read and write issues',
  'pull_requests:read': 'Read pull requests',
  'pull_requests:write': 'Read and write pull requests',
  'workflows:read': 'Read workflows',
  'workflows:write': 'Read and write workflows',
  'metadata:read': 'Read repository metadata',
  'actions:read': 'Read actions',
  'actions:write': 'Read and write actions',
};

// ============================================================================
// GitHub Integration View
// ============================================================================

/**
 * GitHubIntegrationView provides GitHub-specific view functionality.
 * Displays GitHub App installation status, connected repositories, and permissions.
 */
export class GitHubIntegrationView implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private statusBarItem: vscode.StatusBarItem | undefined;

  constructor() {
    const logger = getLogger();
    logger.debug('GitHubIntegrationView initialized');

    // Create status bar item for GitHub connection status
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.statusBarItem.command = 'generacy.integrations.showGitHubStatus';
    this.disposables.push(this.statusBarItem);
  }

  /**
   * Update the status bar with GitHub connection status
   */
  public updateStatusBar(details: IntegrationDetails | undefined): void {
    if (!this.statusBarItem) {
      return;
    }

    if (!details || details.status !== 'connected') {
      this.statusBarItem.hide();
      return;
    }

    const github = details.github;
    if (!github) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = `$(github) ${github.accountName}`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**GitHub:** ${github.accountName}\n\n` +
        `**Type:** ${github.accountType}\n\n` +
        `**Repositories:** ${github.repositories.length}`
    );
    this.statusBarItem.show();
  }

  /**
   * Show detailed GitHub status in a quick pick or webview
   */
  public async showGitHubStatus(): Promise<void> {
    const logger = getLogger();
    logger.info('Showing GitHub integration status');

    try {
      const details = await integrationsApi.getIntegrationDetails('github');

      if (details.status !== 'connected' || !details.github) {
        // Show connect option
        const action = await vscode.window.showInformationMessage(
          'GitHub App is not connected.',
          'Connect GitHub',
          'Cancel'
        );

        if (action === 'Connect GitHub') {
          await this.connectGitHub();
        }
        return;
      }

      const github = details.github;

      // Build quick pick items
      const items: vscode.QuickPickItem[] = [
        {
          label: '$(github) Account',
          description: `${github.accountName} (${github.accountType})`,
          detail: `Installation ID: ${github.installationId}`,
        },
        {
          label: '$(repo) Repositories',
          description: `${github.repositories.length} connected`,
          detail: github.repositories.map((r) => r.fullName).join(', '),
        },
        {
          label: '$(shield) Permissions',
          description: `${github.permissions.length} scopes`,
          detail: github.permissions.join(', '),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
          label: '$(gear) Configure',
          description: 'Manage GitHub App settings',
        },
        {
          label: '$(link-external) View on GitHub',
          description: 'Open GitHub App configuration',
        },
        {
          label: '$(trash) Disconnect',
          description: 'Remove GitHub App connection',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: 'GitHub Integration Status',
        placeHolder: 'Select an action',
      });

      if (!selected) {
        return;
      }

      if (selected.label.includes('Configure')) {
        await this.configureGitHub(github);
      } else if (selected.label.includes('View on GitHub')) {
        await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
      } else if (selected.label.includes('Disconnect')) {
        await this.disconnectGitHub();
      }
    } catch (error) {
      logger.error('Failed to show GitHub status', error);
      vscode.window.showErrorMessage(
        `Failed to load GitHub status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Initiate GitHub App connection
   */
  public async connectGitHub(): Promise<boolean> {
    const logger = getLogger();
    logger.info('Initiating GitHub connection');

    try {
      const result = await integrationsApi.connectIntegration('github');

      // Open the authorization URL in browser
      await vscode.env.openExternal(vscode.Uri.parse(result.authUrl));

      vscode.window.showInformationMessage(
        'Complete the GitHub App installation in your browser. The integration will be available once setup is complete.'
      );

      return true;
    } catch (error) {
      logger.error('Failed to initiate GitHub connection', error);
      vscode.window.showErrorMessage(
        `Failed to connect GitHub: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Disconnect GitHub App
   */
  public async disconnectGitHub(): Promise<boolean> {
    const logger = getLogger();
    logger.info('Disconnecting GitHub');

    // Confirm disconnection
    const confirmed = await vscode.window.showWarningMessage(
      'Are you sure you want to disconnect the GitHub App? This will remove access to all connected repositories.',
      { modal: true },
      'Disconnect'
    );

    if (confirmed !== 'Disconnect') {
      return false;
    }

    try {
      await integrationsApi.disconnectIntegration('github');

      vscode.window.showInformationMessage('GitHub App disconnected successfully.');
      this.updateStatusBar(undefined);

      return true;
    } catch (error) {
      logger.error('Failed to disconnect GitHub', error);
      vscode.window.showErrorMessage(
        `Failed to disconnect GitHub: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Configure GitHub App settings
   */
  public async configureGitHub(github: GitHubInstallation): Promise<void> {
    const logger = getLogger();
    logger.info('Configuring GitHub integration');

    const items: vscode.QuickPickItem[] = [
      {
        label: '$(repo) Manage Repositories',
        description: 'Add or remove repository access',
      },
      {
        label: '$(shield) View Permissions',
        description: 'See granted permission scopes',
      },
      {
        label: '$(link-external) GitHub App Settings',
        description: 'Open configuration on GitHub',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: `Configure GitHub: ${github.accountName}`,
      placeHolder: 'Select configuration option',
    });

    if (!selected) {
      return;
    }

    if (selected.label.includes('Repositories')) {
      await this.showRepositorySelection(github);
    } else if (selected.label.includes('Permissions')) {
      await this.showPermissions(github);
    } else if (selected.label.includes('Settings')) {
      await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
    }
  }

  /**
   * Show repository selection for GitHub
   */
  public async showRepositorySelection(github: GitHubInstallation): Promise<void> {
    const logger = getLogger();
    logger.info('Showing repository selection');

    const items = github.repositories.map((repo) => ({
      label: repo.fullName,
      description: repo.isPrivate ? '$(lock) Private' : '$(repo) Public',
      picked: true,
    }));

    if (items.length === 0) {
      const action = await vscode.window.showInformationMessage(
        'No repositories connected. Would you like to add repositories?',
        'Add Repositories'
      );

      if (action === 'Add Repositories') {
        await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
      }
      return;
    }

    const infoMessage = await vscode.window.showInformationMessage(
      `${github.repositories.length} repositories are connected. To modify repository access, update the GitHub App installation settings.`,
      'Open GitHub Settings'
    );

    if (infoMessage === 'Open GitHub Settings') {
      await vscode.env.openExternal(vscode.Uri.parse(github.configUrl));
    }
  }

  /**
   * Show permission scopes for GitHub
   */
  public async showPermissions(github: GitHubInstallation): Promise<void> {
    const logger = getLogger();
    logger.info('Showing GitHub permissions');

    const items = github.permissions.map((perm) => ({
      label: `$(shield) ${perm}`,
      description: PERMISSION_DESCRIPTIONS[perm] ?? '',
    }));

    await vscode.window.showQuickPick(items, {
      title: 'GitHub App Permissions',
      placeHolder: 'Permission scopes granted to the GitHub App',
      canPickMany: false,
    });
  }

  /**
   * Open GitHub App installation page
   */
  public async openInstallationPage(): Promise<void> {
    const logger = getLogger();
    logger.info('Opening GitHub App installation page');

    await vscode.env.openExternal(vscode.Uri.parse(GITHUB_APP_INSTALL_URL));
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.statusBarItem = undefined;
  }
}

/**
 * Create and register the GitHub integration view
 */
export function createGitHubIntegrationView(
  context: vscode.ExtensionContext
): GitHubIntegrationView {
  const view = new GitHubIntegrationView();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.integrations.showGitHubStatus', () => {
      void view.showGitHubStatus();
    }),
    vscode.commands.registerCommand('generacy.integrations.connectGitHub', () => {
      void view.connectGitHub();
    }),
    vscode.commands.registerCommand('generacy.integrations.disconnectGitHub', () => {
      void view.disconnectGitHub();
    }),
    vscode.commands.registerCommand('generacy.integrations.openGitHubInstall', () => {
      void view.openInstallationPage();
    })
  );

  context.subscriptions.push(view);

  return view;
}
