/**
 * Cloud Integrations module exports.
 * Provides integration management UI for the Generacy VS Code Extension.
 */

// Tree view provider
export {
  IntegrationsTreeProvider,
  IntegrationsViewMode,
  IntegrationsTreeProviderOptions,
  createIntegrationsTreeProvider,
} from './provider';

// Tree items
export {
  IntegrationTreeItem,
  IntegrationTypeGroupItem,
  IntegrationEmptyItem,
  IntegrationLoadingItem,
  IntegrationErrorItem,
  RepositoryTreeItem,
  WebhookTreeItem,
  WebhookSectionItem,
  IntegrationExplorerItem,
  isIntegrationTreeItem,
  isIntegrationTypeGroupItem,
  isWebhookSectionItem,
  isWebhookTreeItem,
  isRepositoryTreeItem,
} from './tree-item';

// GitHub integration
export { GitHubIntegrationView, createGitHubIntegrationView } from './github';

// Status utilities
export {
  StatusDisplayConfig,
  ConnectionResult,
  getStatusDisplay,
  getStatusIcon,
  handleConnect,
  handleDisconnect,
  handleConnectionError,
  needsReconnection,
  getStatusActionLabel,
  getStatusActionCommand,
  registerStatusCommands,
} from './status';

// Configuration panel
export { IntegrationConfigPanel, createIntegrationConfigPanel } from './config';
