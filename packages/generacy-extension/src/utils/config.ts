/**
 * Configuration manager for Generacy VS Code extension.
 * Provides type-safe access to VS Code settings with defaults and change notifications.
 */
import * as vscode from 'vscode';
import { CONFIG_KEYS, DEFAULTS } from '../constants';

/**
 * Extension configuration interface
 */
export interface ExtensionConfig {
  /** Directory containing workflow YAML files */
  workflowDirectory: string;
  /** Default template for new workflows */
  defaultTemplate: 'basic' | 'multi-phase' | 'with-triggers';
  /** Generacy cloud API endpoint */
  cloudEndpoint: string;
  /** Whether anonymous telemetry is enabled */
  telemetryEnabled: boolean;
}

/**
 * Configuration change event
 */
export interface ConfigChangeEvent {
  key: keyof ExtensionConfig;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Configuration change listener type
 */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

/**
 * Configuration manager class
 */
export class ConfigurationManager {
  private static instance: ConfigurationManager | undefined;
  private readonly listeners: Set<ConfigChangeListener> = new Set();
  private cachedConfig: ExtensionConfig | undefined;
  private disposable: vscode.Disposable | undefined;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): ConfigurationManager {
    if (!ConfigurationManager.instance) {
      ConfigurationManager.instance = new ConfigurationManager();
    }
    return ConfigurationManager.instance;
  }

  /**
   * Initialize the configuration manager with VS Code context
   */
  public initialize(context: vscode.ExtensionContext): void {
    // Cache initial config
    this.cachedConfig = this.readConfig();

    // Listen for configuration changes
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('generacy')) {
        this.handleConfigChange();
      }
    });

    context.subscriptions.push(this.disposable);
  }

  /**
   * Get the current configuration
   */
  public getConfig(): ExtensionConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = this.readConfig();
    }
    return { ...this.cachedConfig };
  }

  /**
   * Get a specific configuration value
   */
  public get<K extends keyof ExtensionConfig>(key: K): ExtensionConfig[K] {
    return this.getConfig()[key];
  }

  /**
   * Update a configuration value
   */
  public async set<K extends keyof ExtensionConfig>(
    key: K,
    value: ExtensionConfig[K],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    const section = this.getSettingKey(key);
    await vscode.workspace.getConfiguration('generacy').update(section, value, target);
  }

  /**
   * Add a listener for configuration changes
   */
  public onDidChange(listener: ConfigChangeListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Get the workflow directory as an absolute URI
   */
  public getWorkflowDirectoryUri(workspaceFolder?: vscode.WorkspaceFolder): vscode.Uri | undefined {
    const folder = workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const workflowDir = this.get('workflowDirectory');
    return vscode.Uri.joinPath(folder.uri, workflowDir);
  }

  /**
   * Check if telemetry is enabled
   */
  public isTelemetryEnabled(): boolean {
    // Check both extension setting and VS Code global telemetry setting
    const extensionTelemetry = this.get('telemetryEnabled');
    const vscodeTelemetry = vscode.env.isTelemetryEnabled;
    return extensionTelemetry && vscodeTelemetry;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disposable?.dispose();
    this.listeners.clear();
    this.cachedConfig = undefined;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  public static resetInstance(): void {
    ConfigurationManager.instance?.dispose();
    ConfigurationManager.instance = undefined;
  }

  /**
   * Read configuration from VS Code settings
   */
  private readConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('generacy');
    return {
      workflowDirectory: config.get<string>(
        CONFIG_KEYS.workflowDirectory,
        DEFAULTS.workflowDirectory
      ),
      defaultTemplate: config.get<ExtensionConfig['defaultTemplate']>(
        CONFIG_KEYS.defaultTemplate,
        DEFAULTS.defaultTemplate as ExtensionConfig['defaultTemplate']
      ),
      cloudEndpoint: config.get<string>(CONFIG_KEYS.cloudEndpoint, DEFAULTS.cloudEndpoint),
      telemetryEnabled: config.get<boolean>(CONFIG_KEYS.telemetryEnabled, DEFAULTS.telemetryEnabled),
    };
  }

  /**
   * Handle configuration changes
   */
  private handleConfigChange(): void {
    const oldConfig = this.cachedConfig;
    const newConfig = this.readConfig();
    this.cachedConfig = newConfig;

    if (!oldConfig) {
      return;
    }

    // Notify listeners of changes
    const keys: Array<keyof ExtensionConfig> = [
      'workflowDirectory',
      'defaultTemplate',
      'cloudEndpoint',
      'telemetryEnabled',
    ];

    for (const key of keys) {
      if (oldConfig[key] !== newConfig[key]) {
        const event: ConfigChangeEvent = {
          key,
          oldValue: oldConfig[key],
          newValue: newConfig[key],
        };
        this.notifyListeners(event);
      }
    }
  }

  /**
   * Notify all listeners of a configuration change
   */
  private notifyListeners(event: ConfigChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // Ignore listener errors to prevent one bad listener from affecting others
        console.error('Config change listener error:', error);
      }
    }
  }

  /**
   * Map config key to VS Code setting key
   */
  private getSettingKey(key: keyof ExtensionConfig): string {
    const mapping: Record<keyof ExtensionConfig, string> = {
      workflowDirectory: CONFIG_KEYS.workflowDirectory,
      defaultTemplate: CONFIG_KEYS.defaultTemplate,
      cloudEndpoint: CONFIG_KEYS.cloudEndpoint,
      telemetryEnabled: CONFIG_KEYS.telemetryEnabled,
    };
    return mapping[key];
  }
}

/**
 * Get the singleton configuration manager instance
 */
export function getConfig(): ConfigurationManager {
  return ConfigurationManager.getInstance();
}
