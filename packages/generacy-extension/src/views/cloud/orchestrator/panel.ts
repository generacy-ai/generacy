/**
 * Orchestrator Dashboard Editor Panel
 * Full editor-tab webview following the OrgDashboardPanel singleton pattern.
 * Displays queue summary, agent summary, and activity feed with real-time SSE updates.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import { getSSEManager, type SSEConnectionState } from '../../../api/sse';
import { agentsApi } from '../../../api/endpoints/agents';
import { activityApi } from '../../../api/endpoints/activity';
import { queueApi } from '../../../api/endpoints/queue';
import { CLOUD_COMMANDS } from '../../../constants';
import { getDashboardHtml, type DashboardData, type QueueStats } from './webview';
import type { SSEEvent } from '../../../api/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Messages sent from the dashboard webview to the extension
 */
export type DashboardWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openQueueItem'; id: string }
  | { type: 'openAgent'; id: string }
  | { type: 'openCommand'; command: string };

/**
 * Messages sent from the extension to the dashboard webview
 */
export type DashboardExtensionMessage =
  | { type: 'update'; data: DashboardData }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'sseEvent'; event: SSEEvent }
  | { type: 'connectionStatus'; connected: boolean };

// ============================================================================
// Dashboard Panel Class
// ============================================================================

/**
 * Orchestrator Dashboard Panel manager.
 * Singleton webview panel that shows queue stats, agent cards, and activity feed
 * with hybrid REST + SSE data loading.
 */
export class OrchestratorDashboardPanel {
  private static instance: OrchestratorDashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private sseDisposables: vscode.Disposable[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private isDisposed = false;

  // ==========================================================================
  // Singleton Lifecycle
  // ==========================================================================

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    // Set initial loading HTML
    this.panel.webview.html = this.getLoadingHtml();

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: DashboardWebviewMessage) => this.handleMessage(message),
      null,
      this.disposables,
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables,
    );

    // Handle visibility changes — pause/resume SSE processing
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.subscribeToSSE();
          void this.loadData();
        } else {
          this.unsubscribeFromSSE();
        }
      },
      null,
      this.disposables,
    );

    // Set up auto-refresh interval (60s) as polling fallback
    this.refreshInterval = setInterval(() => {
      if (this.panel.visible && !this.isDisposed) {
        void this.loadData();
      }
    }, 60000);
  }

  /**
   * Create or show the orchestrator dashboard panel.
   * If a panel already exists, it is revealed. Otherwise a new one is created.
   */
  public static createOrShow(extensionUri: vscode.Uri): OrchestratorDashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    // If panel already exists, show it
    if (OrchestratorDashboardPanel.instance) {
      OrchestratorDashboardPanel.instance.panel.reveal(column);
      return OrchestratorDashboardPanel.instance;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'generacyOrchestratorDashboard',
      'Orchestration Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-dark.svg'),
    };

    OrchestratorDashboardPanel.instance = new OrchestratorDashboardPanel(panel, extensionUri);
    return OrchestratorDashboardPanel.instance;
  }

  // ==========================================================================
  // Data Loading
  // ==========================================================================

  /**
   * Fetch queue stats, agent data, and activity feed, then render the dashboard.
   * Uses parallel REST requests for initial load.
   */
  private async loadData(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      this.postMessage({ type: 'error', message: 'Sign in to view the orchestration dashboard.' });
      return;
    }

    this.postMessage({ type: 'loading', isLoading: true });

    try {
      // Fetch all data in parallel
      const [queueResponse, agentStats, agentsResponse, activityResponse] = await Promise.all([
        queueApi.getQueue({ pageSize: 1000 }),
        agentsApi.getAgentStats(),
        agentsApi.getAgents({ pageSize: 100 }),
        activityApi.getActivity({ limit: 50 }),
      ]);

      // Compute queue stats from items
      const queueStats = this.computeQueueStats(queueResponse.items);
      const sseManager = getSSEManager();

      const data: DashboardData = {
        queueStats,
        agentStats,
        agents: agentsResponse.items,
        activity: activityResponse.items,
        connected: sseManager.isConnected(),
      };

      // Render full dashboard HTML
      this.panel.webview.html = getDashboardHtml(this.panel.webview, this.extensionUri, data);

      // Re-subscribe to SSE after re-render since the webview script is new
      this.subscribeToSSE();

      logger.debug('Orchestrator dashboard data loaded successfully');
    } catch (error) {
      logger.error('Failed to load orchestrator dashboard data', error);
      this.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to load dashboard data',
      });
    } finally {
      this.postMessage({ type: 'loading', isLoading: false });
    }
  }

  /**
   * Compute queue stats from queue items by counting statuses.
   */
  private computeQueueStats(items: Array<{ status: string }>): QueueStats {
    const stats: QueueStats = { pending: 0, running: 0, completed: 0, failed: 0 };

    for (const item of items) {
      switch (item.status) {
        case 'pending':
          stats.pending++;
          break;
        case 'running':
          stats.running++;
          break;
        case 'completed':
          stats.completed++;
          break;
        case 'failed':
        case 'cancelled':
          stats.failed++;
          break;
      }
    }

    return stats;
  }

  // ==========================================================================
  // SSE Subscriptions
  // ==========================================================================

  /**
   * Subscribe to all SSE channels for real-time dashboard updates.
   * Forwards SSE events to the webview for incremental DOM updates.
   */
  private subscribeToSSE(): void {
    // Avoid double-subscribing
    this.unsubscribeFromSSE();

    const sseManager = getSSEManager();

    // Subscribe to queue events
    this.sseDisposables.push(
      sseManager.subscribe('queue', (event: SSEEvent) => {
        if (this.panel.visible) {
          this.postMessage({ type: 'sseEvent', event });
        }
      }),
    );

    // Subscribe to agents events
    this.sseDisposables.push(
      sseManager.subscribe('agents', (event: SSEEvent) => {
        if (this.panel.visible) {
          this.postMessage({ type: 'sseEvent', event });
        }
      }),
    );

    // Subscribe to workflows events
    this.sseDisposables.push(
      sseManager.subscribe('workflows', (event: SSEEvent) => {
        if (this.panel.visible) {
          this.postMessage({ type: 'sseEvent', event });
        }
      }),
    );

    // Listen to connection state changes
    this.sseDisposables.push(
      sseManager.onDidChangeConnectionState((state: SSEConnectionState) => {
        this.postMessage({
          type: 'connectionStatus',
          connected: state === 'connected',
        });
      }),
    );
  }

  /**
   * Unsubscribe from all SSE channels.
   */
  private unsubscribeFromSSE(): void {
    for (const disposable of this.sseDisposables) {
      disposable.dispose();
    }
    this.sseDisposables = [];
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  /**
   * Handle messages from the dashboard webview.
   */
  private handleMessage(message: DashboardWebviewMessage): void {
    const logger = getLogger();
    logger.debug('Dashboard panel received message', { type: message.type });

    switch (message.type) {
      case 'ready':
        void this.loadData();
        break;

      case 'refresh':
        void this.loadData();
        break;

      case 'openQueueItem':
        // Open the work item detail panel (delegates to future WorkItemDetailPanel)
        void vscode.commands.executeCommand('generacy.queue.viewDetails', message.id);
        break;

      case 'openAgent':
        // Reveal the agent in the agent tree view
        void vscode.commands.executeCommand(CLOUD_COMMANDS.viewAgentLogs, message.id);
        break;

      case 'openCommand':
        void vscode.commands.executeCommand(message.command);
        break;
    }
  }

  /**
   * Post a message to the dashboard webview.
   */
  private postMessage(message: DashboardExtensionMessage): void {
    if (this.isDisposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  // ==========================================================================
  // Loading HTML
  // ==========================================================================

  /**
   * Get loading HTML shown before data is fetched.
   */
  private getLoadingHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Orchestration Dashboard</title>
  <style nonce="${nonce}">
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    .loading {
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-input-border);
      border-top: 3px solid var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <p>Loading dashboard...</p>
  </div>
</body>
</html>`;
  }

  // ==========================================================================
  // Disposal
  // ==========================================================================

  /**
   * Clean up all resources.
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    OrchestratorDashboardPanel.instance = undefined;

    // Clear auto-refresh timer
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }

    // Unsubscribe from SSE
    this.unsubscribeFromSSE();

    // Dispose the webview panel
    this.panel.dispose();

    // Dispose all other disposables
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  // ==========================================================================
  // Static Utilities
  // ==========================================================================

  /**
   * Check if the dashboard panel exists and is visible.
   */
  public static isVisible(): boolean {
    return OrchestratorDashboardPanel.instance?.panel.visible ?? false;
  }

  /**
   * Get the panel instance if it exists.
   */
  public static getInstance(): OrchestratorDashboardPanel | undefined {
    return OrchestratorDashboardPanel.instance;
  }
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Generate a nonce for CSP.
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ============================================================================
// Registration Helper
// ============================================================================

/**
 * Show the orchestrator dashboard.
 * Convenience function for use in command registration.
 */
export function showOrchestratorDashboard(extensionUri: vscode.Uri): void {
  OrchestratorDashboardPanel.createOrShow(extensionUri);
}
