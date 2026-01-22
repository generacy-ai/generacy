/**
 * Connection status utilities for integrations.
 * Provides status display, connect actions, and error handling.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { integrationsApi } from '../../../api/endpoints/integrations';
import { Integration, IntegrationType, IntegrationStatus } from '../../../api/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Status display configuration
 */
export interface StatusDisplayConfig {
  label: string;
  icon: string;
  color: string;
  description: string;
}

/**
 * Connection result
 */
export interface ConnectionResult {
  success: boolean;
  integrationType: IntegrationType;
  message: string;
  error?: Error;
}

// ============================================================================
// Status Display
// ============================================================================

/**
 * Status display configurations by status
 */
const STATUS_DISPLAY: Record<IntegrationStatus, StatusDisplayConfig> = {
  connected: {
    label: 'Connected',
    icon: 'check',
    color: 'charts.green',
    description: 'Integration is active and working',
  },
  disconnected: {
    label: 'Not Connected',
    icon: 'circle-slash',
    color: 'charts.gray',
    description: 'Click to connect this integration',
  },
  error: {
    label: 'Error',
    icon: 'error',
    color: 'charts.red',
    description: 'Connection error occurred',
  },
};

/**
 * Get status display configuration
 */
export function getStatusDisplay(status: IntegrationStatus): StatusDisplayConfig {
  return STATUS_DISPLAY[status];
}

/**
 * Get status icon as ThemeIcon
 */
export function getStatusIcon(status: IntegrationStatus): vscode.ThemeIcon {
  const config = STATUS_DISPLAY[status];
  return new vscode.ThemeIcon(config.icon, new vscode.ThemeColor(config.color));
}

// ============================================================================
// Connection Handlers
// ============================================================================

/**
 * Integration type display names
 */
const TYPE_NAMES: Record<IntegrationType, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
  linear: 'Linear',
};

/**
 * Handle connect action for an integration
 */
export async function handleConnect(type: IntegrationType): Promise<ConnectionResult> {
  const logger = getLogger();
  const typeName = TYPE_NAMES[type];

  logger.info(`Initiating connection for ${typeName}`);

  try {
    // Show progress notification
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting ${typeName}...`,
        cancellable: false,
      },
      async () => {
        return await integrationsApi.connectIntegration(type);
      }
    );

    // Open the authorization URL
    await vscode.env.openExternal(vscode.Uri.parse(result.authUrl));

    vscode.window.showInformationMessage(
      `Complete the ${typeName} authorization in your browser.`
    );

    return {
      success: true,
      integrationType: type,
      message: `${typeName} authorization started`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to connect ${typeName}`, error);

    vscode.window.showErrorMessage(`Failed to connect ${typeName}: ${errorMessage}`);

    return {
      success: false,
      integrationType: type,
      message: `Failed to connect ${typeName}`,
      error: error instanceof Error ? error : new Error(errorMessage),
    };
  }
}

/**
 * Handle disconnect action for an integration
 */
export async function handleDisconnect(type: IntegrationType): Promise<ConnectionResult> {
  const logger = getLogger();
  const typeName = TYPE_NAMES[type];

  logger.info(`Initiating disconnection for ${typeName}`);

  // Confirm disconnection
  const confirmed = await vscode.window.showWarningMessage(
    `Are you sure you want to disconnect ${typeName}? This will remove all access to connected resources.`,
    { modal: true },
    'Disconnect'
  );

  if (confirmed !== 'Disconnect') {
    return {
      success: false,
      integrationType: type,
      message: 'Disconnection cancelled',
    };
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Disconnecting ${typeName}...`,
        cancellable: false,
      },
      async () => {
        await integrationsApi.disconnectIntegration(type);
      }
    );

    vscode.window.showInformationMessage(`${typeName} disconnected successfully.`);

    return {
      success: true,
      integrationType: type,
      message: `${typeName} disconnected`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to disconnect ${typeName}`, error);

    vscode.window.showErrorMessage(`Failed to disconnect ${typeName}: ${errorMessage}`);

    return {
      success: false,
      integrationType: type,
      message: `Failed to disconnect ${typeName}`,
      error: error instanceof Error ? error : new Error(errorMessage),
    };
  }
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Handle integration connection errors gracefully
 */
export function handleConnectionError(
  type: IntegrationType,
  error: Error
): void {
  const logger = getLogger();
  const typeName = TYPE_NAMES[type];

  logger.error(`Connection error for ${typeName}`, error);

  // Determine error type and show appropriate message
  const errorMessage = error.message.toLowerCase();

  if (errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
    vscode.window.showErrorMessage(
      `${typeName} authentication failed. Please try reconnecting.`,
      'Reconnect'
    ).then((action) => {
      if (action === 'Reconnect') {
        void handleConnect(type);
      }
    });
  } else if (errorMessage.includes('forbidden') || errorMessage.includes('403')) {
    vscode.window.showErrorMessage(
      `${typeName} access denied. Please check your permissions.`,
      'View Details'
    ).then((action) => {
      if (action === 'View Details') {
        showErrorDetails(type, error);
      }
    });
  } else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
    vscode.window.showErrorMessage(
      `Unable to reach ${typeName}. Please check your network connection.`,
      'Retry'
    ).then((action) => {
      if (action === 'Retry') {
        vscode.commands.executeCommand('generacy.integrations.refresh');
      }
    });
  } else {
    vscode.window.showErrorMessage(
      `${typeName} error: ${error.message}`,
      'View Details'
    ).then((action) => {
      if (action === 'View Details') {
        showErrorDetails(type, error);
      }
    });
  }
}

/**
 * Show detailed error information
 */
function showErrorDetails(type: IntegrationType, error: Error): void {
  const typeName = TYPE_NAMES[type];
  const channel = vscode.window.createOutputChannel(`Generacy - ${typeName} Error`);

  channel.appendLine(`Integration: ${typeName}`);
  channel.appendLine(`Timestamp: ${new Date().toISOString()}`);
  channel.appendLine(`Error: ${error.message}`);
  channel.appendLine('');
  channel.appendLine('Stack trace:');
  channel.appendLine(error.stack ?? 'No stack trace available');

  channel.show();
}

// ============================================================================
// Status Monitoring
// ============================================================================

/**
 * Check if an integration needs reconnection
 */
export function needsReconnection(integration: Integration): boolean {
  return integration.status === 'error' || integration.status === 'disconnected';
}

/**
 * Get action label for integration status
 */
export function getStatusActionLabel(status: IntegrationStatus): string {
  switch (status) {
    case 'connected':
      return 'Manage';
    case 'disconnected':
      return 'Connect';
    case 'error':
      return 'Reconnect';
  }
}

/**
 * Get action command for integration status
 */
export function getStatusActionCommand(
  type: IntegrationType,
  status: IntegrationStatus
): string {
  switch (status) {
    case 'connected':
      return `generacy.integrations.configure.${type}`;
    case 'disconnected':
      return 'generacy.integrations.connect';
    case 'error':
      return 'generacy.integrations.connect';
  }
}

// ============================================================================
// Register Commands
// ============================================================================

/**
 * Register integration status commands
 */
export function registerStatusCommands(context: vscode.ExtensionContext): void {
  // Generic connect command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.integrations.connect',
      async (type?: IntegrationType) => {
        if (!type) {
          // Show quick pick for integration type
          const selected = await vscode.window.showQuickPick(
            [
              { label: '$(github) GitHub', type: 'github' as IntegrationType },
              { label: '$(git-merge) GitLab', type: 'gitlab' as IntegrationType },
              { label: '$(git-branch) Bitbucket', type: 'bitbucket' as IntegrationType },
              { label: '$(issues) Jira', type: 'jira' as IntegrationType },
              { label: '$(checklist) Linear', type: 'linear' as IntegrationType },
            ],
            { placeHolder: 'Select integration to connect' }
          );

          if (!selected) {
            return;
          }

          type = selected.type;
        }

        await handleConnect(type);
      }
    )
  );

  // Generic disconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.integrations.disconnect',
      async (type: IntegrationType) => {
        if (!type) {
          return;
        }

        await handleDisconnect(type);
      }
    )
  );
}
