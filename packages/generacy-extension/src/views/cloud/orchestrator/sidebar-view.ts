/**
 * Orchestrator Sidebar Summary WebviewViewProvider
 * Displays a compact summary of queue and agent stats in the sidebar,
 * with real-time updates via SSE and a button to open the full dashboard.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import { getSSEManager, type SSEConnectionState } from '../../../api/sse';
import { agentsApi } from '../../../api/endpoints/agents';
import { queueApi } from '../../../api/endpoints/queue';
import { VIEWS, CLOUD_COMMANDS } from '../../../constants';
import { getSidebarHtml, type SidebarData, type QueueStats } from './webview';
import type { SSEEvent } from '../../../api/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Messages sent from the sidebar webview to the extension
 */
type SidebarWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openDashboard' };

/**
 * Messages sent from the extension to the sidebar webview
 */
type SidebarExtensionMessage =
  | { type: 'update'; data: SidebarData }
  | { type: 'connectionStatus'; connected: boolean }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string };

// ============================================================================
// Sidebar View Provider
// ============================================================================

/**
 * Provides the orchestrator summary sidebar webview.
 * Shows queue stats, agent stats, and connection status with real-time SSE updates.
 */
export class OrchestratorSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = VIEWS.orchestratorSummary;

  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private sseDisposables: vscode.Disposable[] = [];
  private isDisposed = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // ==========================================================================
  // WebviewViewProvider
  // ==========================================================================

  /**
   * Called when the webview view is resolved (made visible for the first time).
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    // Configure webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')],
    };

    // Set initial loading HTML
    webviewView.webview.html = this.getLoadingHtml();

    // Listen for messages from the webview
    webviewView.webview.onDidReceiveMessage(
      (message: SidebarWebviewMessage) => this.handleMessage(message),
      null,
      this.disposables,
    );

    // Handle visibility changes — pause/resume SSE processing
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this.subscribeToSSE();
          void this.loadData();
        } else {
          this.unsubscribeFromSSE();
        }
      },
      null,
      this.disposables,
    );

    // Handle disposal
    webviewView.onDidDispose(
      () => {
        this.unsubscribeFromSSE();
        this.view = undefined;
      },
      null,
      this.disposables,
    );
  }

  // ==========================================================================
  // Data Loading
  // ==========================================================================

  /**
   * Fetch queue stats and agent stats, then update the webview.
   */
  private async loadData(): Promise<void> {
    if (this.isDisposed || !this.view) {
      return;
    }

    const logger = getLogger();
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      this.postMessage({ type: 'error', message: 'Sign in to view orchestrator status.' });
      return;
    }

    this.postMessage({ type: 'loading', isLoading: true });

    try {
      // Fetch queue items and agent stats in parallel
      const [queueResponse, agentStats] = await Promise.all([
        queueApi.getQueue({ pageSize: 1000 }),
        agentsApi.getAgentStats(),
      ]);

      // Compute queue stats from items
      const queueStats = this.computeQueueStats(queueResponse.items);
      const sseManager = getSSEManager();

      const data: SidebarData = {
        queueStats,
        agentStats,
        connected: sseManager.isConnected(),
      };

      // Update webview with full HTML (sidebar content is compact enough for full re-render)
      if (this.view) {
        this.view.webview.html = getSidebarHtml(this.view.webview, this.extensionUri, data);

        // Re-subscribe to SSE after re-render since the webview script is new
        this.subscribeToSSE();
      }

      logger.debug('Sidebar data loaded successfully');
    } catch (error) {
      logger.error('Failed to load sidebar data', error);
      this.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to load orchestrator data',
      });
    } finally {
      this.postMessage({ type: 'loading', isLoading: false });
    }
  }

  /**
   * Compute queue stats from queue items by counting statuses.
   */
  private computeQueueStats(items: Array<{ status: string }>): QueueStats {
    const stats: QueueStats = { pending: 0, waiting: 0, running: 0, completed: 0, failed: 0 };

    for (const item of items) {
      switch (item.status) {
        case 'pending':
          stats.pending++;
          break;
        case 'waiting':
          stats.waiting++;
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
   * Subscribe to SSE queue and agents channels for real-time updates.
   */
  private subscribeToSSE(): void {
    // Avoid double-subscribing
    this.unsubscribeFromSSE();

    const sseManager = getSSEManager();

    // Subscribe to queue events
    this.sseDisposables.push(
      sseManager.subscribe('queue', (event: SSEEvent) => {
        if (this.view?.visible) {
          this.handleSSEEvent(event);
        }
      }),
    );

    // Subscribe to agents events
    this.sseDisposables.push(
      sseManager.subscribe('agents', (event: SSEEvent) => {
        if (this.view?.visible) {
          this.handleSSEEvent(event);
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

  /**
   * Handle an incoming SSE event by re-fetching data.
   * For a compact sidebar, a full refresh is simpler than incremental DOM updates.
   */
  private handleSSEEvent(_event: SSEEvent): void {
    // Debounce: just re-load all data on any relevant event
    void this.loadData();
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  /**
   * Handle messages from the sidebar webview.
   */
  private handleMessage(message: SidebarWebviewMessage): void {
    const logger = getLogger();
    logger.debug('Sidebar received message', { type: message.type });

    switch (message.type) {
      case 'ready':
        void this.loadData();
        break;

      case 'refresh':
        void this.loadData();
        break;

      case 'openDashboard':
        void vscode.commands.executeCommand(CLOUD_COMMANDS.openDashboard);
        break;
    }
  }

  /**
   * Post a message to the sidebar webview.
   */
  private postMessage(message: SidebarExtensionMessage): void {
    if (this.isDisposed || !this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
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
  <title>Orchestrator Summary</title>
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
      width: 24px;
      height: 24px;
      border: 2px solid var(--vscode-input-border);
      border-top: 2px solid var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    p {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <p>Loading...</p>
  </div>
</body>
</html>`;
  }

  // ==========================================================================
  // Disposable
  // ==========================================================================

  /**
   * Clean up all resources.
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.unsubscribeFromSSE();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
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
 * Register the orchestrator sidebar view provider.
 * Call this from extension activation.
 */
export function registerOrchestratorSidebar(context: vscode.ExtensionContext): OrchestratorSidebarViewProvider {
  const provider = new OrchestratorSidebarViewProvider(context.extensionUri);

  const registration = vscode.window.registerWebviewViewProvider(
    OrchestratorSidebarViewProvider.viewType,
    provider,
  );

  context.subscriptions.push(registration);
  context.subscriptions.push(provider);

  return provider;
}
