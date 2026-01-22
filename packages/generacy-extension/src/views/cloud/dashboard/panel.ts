/**
 * Organization Dashboard Panel
 * Manages the webview panel lifecycle and message communication.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import {
  getOrganizationDashboard,
  type OrgDashboardData,
} from '../../../api/endpoints/orgs';
import { getDashboardHtml } from './webview';

// ============================================================================
// Types
// ============================================================================

/**
 * Messages sent from webview to extension
 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'upgrade'; targetTier: string }
  | { type: 'manageBilling' }
  | { type: 'inviteMember' }
  | { type: 'openLink'; url: string };

/**
 * Messages sent from extension to webview
 */
export type ExtensionMessage =
  | { type: 'update'; data: OrgDashboardData }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string };

// ============================================================================
// Dashboard Panel Class
// ============================================================================

/**
 * Organization Dashboard Panel manager
 */
export class OrgDashboardPanel {
  private static instance: OrgDashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private isDisposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    // Set up webview content
    this.panel.webview.html = this.getLoadingHtml();

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    // Handle visibility changes
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          void this.refresh();
        }
      },
      null,
      this.disposables
    );

    // Set up auto-refresh (every 60 seconds when visible)
    this.refreshInterval = setInterval(() => {
      if (this.panel.visible && !this.isDisposed) {
        void this.refresh();
      }
    }, 60000);
  }

  /**
   * Create or show the dashboard panel
   */
  public static createOrShow(extensionUri: vscode.Uri): OrgDashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    // If panel already exists, show it
    if (OrgDashboardPanel.instance) {
      OrgDashboardPanel.instance.panel.reveal(column);
      return OrgDashboardPanel.instance;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'generacyOrgDashboard',
      'Organization Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-dark.svg'),
    };

    OrgDashboardPanel.instance = new OrgDashboardPanel(panel, extensionUri);
    return OrgDashboardPanel.instance;
  }

  /**
   * Get loading HTML while data is fetched
   */
  private getLoadingHtml(): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Organization Dashboard</title>
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

  /**
   * Generate nonce for CSP
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Refresh dashboard data
   */
  public async refresh(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();
    const authService = getAuthService();

    // Check if authenticated
    if (!authService.isAuthenticated()) {
      this.panel.webview.html = this.getNotAuthenticatedHtml();
      return;
    }

    // Get organization ID from user
    const user = authService.getUser();
    if (!user?.organizationId) {
      this.panel.webview.html = this.getNoOrganizationHtml();
      return;
    }

    // Send loading state
    void this.postMessage({ type: 'loading', isLoading: true });

    try {
      logger.debug('Fetching organization dashboard data');
      const data = await getOrganizationDashboard(user.organizationId);

      // Update webview with dashboard HTML
      this.panel.webview.html = getDashboardHtml(this.panel.webview, this.extensionUri, data);

      logger.debug('Dashboard data loaded successfully');
    } catch (error) {
      logger.error('Failed to fetch dashboard data', error);
      void this.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to load dashboard data',
      });
    } finally {
      void this.postMessage({ type: 'loading', isLoading: false });
    }
  }

  /**
   * Get HTML for not authenticated state
   */
  private getNotAuthenticatedHtml(): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Organization Dashboard</title>
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
    .container {
      text-align: center;
      max-width: 400px;
      padding: 24px;
    }
    h2 {
      margin-bottom: 16px;
    }
    p {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
    }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 24px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 4px;
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>Sign In Required</h2>
    <p>Please sign in to view your organization dashboard.</p>
    <button onclick="login()">Sign In with GitHub</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function login() {
      vscode.postMessage({ type: 'openLink', url: 'command:generacy.login' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Get HTML for no organization state
   */
  private getNoOrganizationHtml(): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Organization Dashboard</title>
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
    .container {
      text-align: center;
      max-width: 500px;
      padding: 24px;
    }
    h2 {
      margin-bottom: 16px;
    }
    p {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
    }
    .features {
      text-align: left;
      margin: 24px 0;
      padding: 16px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 8px;
    }
    .features h3 {
      margin-top: 0;
      margin-bottom: 12px;
    }
    .features ul {
      margin: 0;
      padding-left: 20px;
    }
    .features li {
      margin: 8px 0;
    }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 24px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 4px;
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>No Organization</h2>
    <p>You're not part of any organization yet. Create or join an organization to access cloud features.</p>
    <div class="features">
      <h3>Cloud Mode Features</h3>
      <ul>
        <li>Team workflow orchestration</li>
        <li>Concurrent agent execution</li>
        <li>GitHub/GitLab/Jira integrations</li>
        <li>Workflow queue management</li>
        <li>Publishing and versioning</li>
      </ul>
    </div>
    <button onclick="learnMore()">Learn More</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function learnMore() {
      vscode.postMessage({ type: 'openLink', url: 'https://generacy.ai/pricing' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Handle messages from webview
   */
  private handleMessage(message: WebviewMessage): void {
    const logger = getLogger();
    logger.debug('Received message from webview', { type: message.type });

    switch (message.type) {
      case 'ready':
        void this.refresh();
        break;

      case 'refresh':
        void this.refresh();
        break;

      case 'upgrade':
        void vscode.env.openExternal(
          vscode.Uri.parse(`https://generacy.ai/upgrade?tier=${message.targetTier}`)
        );
        break;

      case 'manageBilling':
        void vscode.env.openExternal(
          vscode.Uri.parse('https://generacy.ai/billing')
        );
        break;

      case 'inviteMember':
        void vscode.env.openExternal(
          vscode.Uri.parse('https://generacy.ai/settings/members')
        );
        break;

      case 'openLink':
        if (message.url.startsWith('command:')) {
          void vscode.commands.executeCommand(message.url.replace('command:', ''));
        } else {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
    }
  }

  /**
   * Post message to webview
   */
  private async postMessage(message: ExtensionMessage): Promise<boolean> {
    if (this.isDisposed) {
      return false;
    }
    return this.panel.webview.postMessage(message);
  }

  /**
   * Dispose the panel
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    OrgDashboardPanel.instance = undefined;

    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  /**
   * Check if panel exists and is visible
   */
  public static isVisible(): boolean {
    return OrgDashboardPanel.instance?.panel.visible ?? false;
  }

  /**
   * Get panel instance if exists
   */
  public static getInstance(): OrgDashboardPanel | undefined {
    return OrgDashboardPanel.instance;
  }
}

/**
 * Show the organization dashboard
 */
export function showOrgDashboard(extensionUri: vscode.Uri): void {
  const panel = OrgDashboardPanel.createOrShow(extensionUri);
  void panel.refresh();
}
