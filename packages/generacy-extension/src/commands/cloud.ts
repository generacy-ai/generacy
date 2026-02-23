/**
 * Cloud commands for Generacy VS Code extension.
 * Handles authentication and cloud-related operations.
 */
import * as vscode from 'vscode';
import { getLogger, getConfig, GeneracyError, ErrorCode, withErrorHandling } from '../utils';
import { getAuthService, AuthTier, type AuthChangeEvent } from '../api/auth';
import {
  publishWorkflowCommand,
  compareWithCloudCommand,
  viewVersionHistoryCommand,
  rollbackWorkflowCommand,
  refreshSyncStatusCommand,
  registerCloudWorkflowProvider,
  registerDecorationProvider,
} from '../views/cloud/publish';
import { SSESubscriptionManager } from '../api/sse';
import { createAgentTreeProvider } from '../views/cloud/agents';
import { createQueueTreeProvider } from '../views/cloud/queue';
import { registerOrchestratorSidebar, OrchestratorDashboardPanel } from '../views/cloud/orchestrator';
import { NotificationManager } from '../utils/notifications';
import { CloudJobStatusBarProvider } from '../providers/status-bar';
import { CLOUD_COMMANDS as ORCH_COMMANDS, CONTEXT_KEYS } from '../constants';

/**
 * Cloud command identifiers
 */
export const CLOUD_COMMANDS = {
  login: 'generacy.login',
  logout: 'generacy.logout',
  showAccount: 'generacy.showAccount',
  publishWorkflow: 'generacy.publishWorkflow',
  compareWithCloud: 'generacy.compareWithCloud',
  viewVersionHistory: 'generacy.viewVersionHistory',
  rollbackWorkflow: 'generacy.rollbackWorkflow',
  refreshSyncStatus: 'generacy.refreshSyncStatus',
} as const;

/**
 * Register cloud commands
 */
export function registerCloudCommands(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  logger.info('Registering cloud commands');

  const commands: Array<{
    id: string;
    handler: (...args: unknown[]) => void | Promise<void>;
  }> = [
    {
      id: CLOUD_COMMANDS.login,
      handler: withErrorHandling(handleLogin, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.logout,
      handler: withErrorHandling(handleLogout, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.showAccount,
      handler: withErrorHandling(handleShowAccount, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.publishWorkflow,
      handler: withErrorHandling(publishWorkflowCommand, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.compareWithCloud,
      handler: withErrorHandling(compareWithCloudCommand, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.viewVersionHistory,
      handler: withErrorHandling(viewVersionHistoryCommand, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.rollbackWorkflow,
      handler: withErrorHandling(rollbackWorkflowCommand, { showOutput: true }),
    },
    {
      id: CLOUD_COMMANDS.refreshSyncStatus,
      handler: withErrorHandling(refreshSyncStatusCommand, { showOutput: true }),
    },
  ];

  for (const { id, handler } of commands) {
    const disposable = vscode.commands.registerCommand(id, handler);
    context.subscriptions.push(disposable);
    logger.debug(`Registered cloud command: ${id}`);
  }

  // Register workflow publishing providers
  registerCloudWorkflowProvider(context);
  registerDecorationProvider(context);
  logger.info('Workflow publishing providers registered');
}

/**
 * Initialize cloud services
 */
export async function initializeCloudServices(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.info('Initializing cloud services');

  // Initialize auth service
  const authService = getAuthService();
  await authService.initialize(context);

  // Register auth change listener
  context.subscriptions.push(
    authService.onDidChange(handleAuthChange)
  );

  // Add auth service to disposables
  context.subscriptions.push({
    dispose: () => authService.dispose(),
  });

  // --- Orchestration UI wiring ---

  // Initialize SSE manager and connect/disconnect based on auth state
  const sseManager = SSESubscriptionManager.getInstance();
  context.subscriptions.push(sseManager);

  // Set orchestratorConnected context key based on SSE connection state
  context.subscriptions.push(
    sseManager.onDidChangeConnectionState((state) => {
      void vscode.commands.executeCommand(
        'setContext',
        CONTEXT_KEYS.orchestratorConnected,
        state === 'connected',
      );
    }),
  );

  // Connect SSE when authenticated, disconnect when not
  context.subscriptions.push(
    authService.onDidChange(async (event) => {
      if (event.newState.isAuthenticated) {
        const orchestratorUrl = vscode.workspace.getConfiguration('generacy').get<string>('orchestratorUrl', 'http://localhost:3100');
        const token = await authService.getAccessToken();
        if (token) {
          sseManager.connect(orchestratorUrl, token);
        }
      } else {
        sseManager.disconnect();
      }
    }),
  );

  // If already authenticated, connect SSE now
  if (authService.isAuthenticated()) {
    const orchestratorUrl = vscode.workspace.getConfiguration('generacy').get<string>('orchestratorUrl', 'http://localhost:3100');
    const token = await authService.getAccessToken();
    if (token) {
      sseManager.connect(orchestratorUrl, token);
    }
  }

  // Register agent tree view (handles its own commands and actions internally)
  createAgentTreeProvider(context);
  logger.info('Agent tree view registered');

  // Register orchestrator sidebar summary view
  registerOrchestratorSidebar(context);
  logger.info('Orchestrator sidebar registered');

  // Register dashboard open command
  context.subscriptions.push(
    vscode.commands.registerCommand(ORCH_COMMANDS.openDashboard, () => {
      OrchestratorDashboardPanel.createOrShow(context.extensionUri);
    }),
  );
  logger.info('Dashboard command registered');

  // Register queue tree view — this also creates the `generacy.queue.focus`
  // command automatically via createTreeView, used by the status bar to reveal the view
  const queueProvider = createQueueTreeProvider(context);
  logger.info('Queue tree view registered');

  const cloudStatusBar = new CloudJobStatusBarProvider();
  context.subscriptions.push(cloudStatusBar);

  // Helper to sync status bar count from queue provider
  const updateStatusBarCount = (): void => {
    const runningCount = queueProvider.getItemsByStatus('running').length;
    cloudStatusBar.updateCount(runningCount);
  };

  // Update status bar on SSE queue events (real-time)
  context.subscriptions.push(
    sseManager.subscribe('queue', () => {
      // Defer to next tick so the tree provider processes the event first
      setTimeout(updateStatusBarCount, 250);
    })
  );

  // Update status bar on tree provider data changes (polling fallback)
  context.subscriptions.push(
    queueProvider.onDidChangeTreeData(() => {
      updateStatusBarCount();
    })
  );

  logger.info('Cloud job status bar initialized');

  // Initialize notification manager
  const notificationManager = new NotificationManager();
  context.subscriptions.push(notificationManager);
  logger.info('Notification manager initialized');

  logger.info('Cloud services initialized');
}

/**
 * Handle login command
 */
async function handleLogin(): Promise<void> {
  const logger = getLogger();
  const authService = getAuthService();

  logger.info('Command: Login');

  // Check if already authenticated
  if (authService.isAuthenticated()) {
    const user = authService.getUser();
    const action = await vscode.window.showInformationMessage(
      `You are already logged in as ${user?.displayName ?? user?.username}`,
      'Switch Account',
      'Show Account'
    );

    if (action === 'Switch Account') {
      await authService.logout();
      await authService.login();
    } else if (action === 'Show Account') {
      await handleShowAccount();
    }
    return;
  }

  // Show login progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Signing in to Generacy...',
      cancellable: false,
    },
    async () => {
      const success = await authService.login();

      if (success) {
        const user = authService.getUser();
        const tierMessage = getTierMessage(authService.getTier());

        vscode.window.showInformationMessage(
          `Welcome, ${user?.displayName ?? user?.username}! ${tierMessage}`
        );
      } else {
        vscode.window.showWarningMessage('Login was cancelled or timed out');
      }
    }
  );
}

/**
 * Handle logout command
 */
async function handleLogout(): Promise<void> {
  const logger = getLogger();
  const authService = getAuthService();

  logger.info('Command: Logout');

  // Check if authenticated
  if (!authService.isAuthenticated()) {
    vscode.window.showInformationMessage('You are not currently logged in');
    return;
  }

  const user = authService.getUser();
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to sign out${user ? ` from ${user.displayName ?? user.username}` : ''}?`,
    { modal: true },
    'Sign Out'
  );

  if (confirm === 'Sign Out') {
    await authService.logout();
    vscode.window.showInformationMessage('You have been signed out');
  }
}

/**
 * Handle show account command
 */
async function handleShowAccount(): Promise<void> {
  const logger = getLogger();
  const authService = getAuthService();

  logger.info('Command: Show Account');

  if (!authService.isAuthenticated()) {
    const action = await vscode.window.showInformationMessage(
      'You are not logged in. Sign in to access cloud features.',
      'Sign In'
    );

    if (action === 'Sign In') {
      await handleLogin();
    }
    return;
  }

  const user = authService.getUser();
  const tier = authService.getTier();

  if (!user) {
    throw new GeneracyError(ErrorCode.AuthFailed, 'Unable to retrieve user information');
  }

  // Build account info message
  const lines = [
    `**${user.displayName ?? user.username}**`,
    '',
    `Username: @${user.username}`,
  ];

  if (user.email) {
    lines.push(`Email: ${user.email}`);
  }

  lines.push(`Tier: ${formatTier(tier)}`);

  if (user.organizationName) {
    lines.push(`Organization: ${user.organizationName}`);
  }

  // Show quick pick with actions
  const actions: vscode.QuickPickItem[] = [];

  if (tier === AuthTier.Free) {
    actions.push({
      label: '$(organization) Join an Organization',
      description: 'Unlock cloud features',
    });
  }

  actions.push(
    {
      label: '$(gear) Account Settings',
      description: 'Open generacy.ai settings',
    },
    {
      label: '$(sign-out) Sign Out',
      description: 'Sign out of your account',
    }
  );

  const infoItem: vscode.QuickPickItem = {
    label: user.displayName ?? user.username,
    description: formatTier(tier),
    detail: user.organizationName
      ? `Organization: ${user.organizationName}`
      : user.email ?? `@${user.username}`,
  };

  const selected = await vscode.window.showQuickPick([infoItem, ...actions], {
    title: 'Generacy Account',
    placeHolder: 'Select an action',
  });

  if (!selected) {
    return;
  }

  if (selected.label.includes('Sign Out')) {
    await handleLogout();
  } else if (selected.label.includes('Account Settings')) {
    const config = getConfig();
    const cloudEndpoint = config.get('cloudEndpoint');
    await vscode.env.openExternal(vscode.Uri.parse(`${cloudEndpoint}/settings`));
  } else if (selected.label.includes('Join an Organization')) {
    const config = getConfig();
    const cloudEndpoint = config.get('cloudEndpoint');
    await vscode.env.openExternal(vscode.Uri.parse(`${cloudEndpoint}/organizations`));
  }
}

/**
 * Handle authentication change events
 */
function handleAuthChange(event: AuthChangeEvent): void {
  const logger = getLogger();

  logger.info('Authentication state changed', {
    reason: event.reason,
    wasAuthenticated: event.previousState.isAuthenticated,
    isAuthenticated: event.newState.isAuthenticated,
    previousTier: event.previousState.tier,
    newTier: event.newState.tier,
  });

  // Handle tier changes (e.g., user joined an organization)
  if (
    event.reason === 'tier_change' &&
    event.previousState.tier !== event.newState.tier
  ) {
    const tierMessage = getTierMessage(event.newState.tier);
    vscode.window.showInformationMessage(`Your account has been upgraded. ${tierMessage}`);
  }
}

/**
 * Get a user-friendly message for an auth tier
 */
function getTierMessage(tier: AuthTier): string {
  switch (tier) {
    case AuthTier.Organization:
      return 'Cloud features are now available.';
    case AuthTier.Free:
      return 'Local mode is now available. Join an organization to unlock cloud features.';
    case AuthTier.Anonymous:
    default:
      return '';
  }
}

/**
 * Format tier for display
 */
function formatTier(tier: AuthTier): string {
  switch (tier) {
    case AuthTier.Organization:
      return 'Organization';
    case AuthTier.Free:
      return 'Free';
    case AuthTier.Anonymous:
    default:
      return 'Anonymous';
  }
}

/**
 * Check if a feature requires a minimum tier
 */
export function requiresTier(
  minimumTier: AuthTier,
  featureName: string
): boolean {
  const authService = getAuthService();

  if (authService.hasMinimumTier(minimumTier)) {
    return true;
  }

  // Show upgrade prompt
  const currentTier = authService.getTier();
  let message: string;
  let action: string;

  if (currentTier === AuthTier.Anonymous) {
    message = `${featureName} requires a Generacy account.`;
    action = 'Sign In';
  } else {
    message = `${featureName} requires an organization membership.`;
    action = 'Learn More';
  }

  vscode.window.showWarningMessage(message, action).then((selected) => {
    if (selected === 'Sign In') {
      void handleLogin();
    } else if (selected === 'Learn More') {
      const config = getConfig();
      const cloudEndpoint = config.get('cloudEndpoint');
      void vscode.env.openExternal(vscode.Uri.parse(`${cloudEndpoint}/pricing`));
    }
  });

  return false;
}
