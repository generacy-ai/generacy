/**
 * Environment variable configuration UI.
 * Provides UI for configuring environment variables before workflow execution.
 */
import * as vscode from 'vscode';

/**
 * Environment variable entry
 */
export interface EnvVariable {
  key: string;
  value: string;
  isSecret?: boolean;
}

/**
 * Environment configuration result
 */
export interface EnvConfigResult {
  cancelled: boolean;
  env: Record<string, string>;
}

/**
 * Environment configuration manager
 */
export class EnvConfigManager {
  private static instance: EnvConfigManager | undefined;
  private savedEnv: Map<string, Record<string, string>> = new Map();

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): EnvConfigManager {
    if (!EnvConfigManager.instance) {
      EnvConfigManager.instance = new EnvConfigManager();
    }
    return EnvConfigManager.instance;
  }

  /**
   * Show environment configuration quick pick
   */
  public async showEnvConfiguration(
    workflowName: string,
    currentEnv?: Record<string, string>
  ): Promise<EnvConfigResult> {
    // Merge saved env with current env
    const savedEnv = this.savedEnv.get(workflowName) || {};
    const mergedEnv = { ...savedEnv, ...currentEnv };

    // Show quick pick with options
    const items: vscode.QuickPickItem[] = [
      {
        label: '$(play) Run with current environment',
        description: 'Use the current environment variables',
        detail: this.formatEnvSummary(mergedEnv),
      },
      {
        label: '$(add) Add environment variable',
        description: 'Add a new environment variable',
      },
      {
        label: '$(edit) Edit environment variables',
        description: 'Edit existing environment variables',
      },
      {
        label: '$(clear-all) Clear all environment variables',
        description: 'Remove all custom environment variables',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: `Environment Configuration: ${workflowName}`,
      placeHolder: 'Select an action',
    });

    if (!selected) {
      return { cancelled: true, env: mergedEnv };
    }

    switch (selected.label) {
      case '$(play) Run with current environment':
        return { cancelled: false, env: mergedEnv };

      case '$(add) Add environment variable':
        return this.addEnvironmentVariable(workflowName, mergedEnv);

      case '$(edit) Edit environment variables':
        return this.editEnvironmentVariables(workflowName, mergedEnv);

      case '$(clear-all) Clear all environment variables':
        this.savedEnv.delete(workflowName);
        return { cancelled: false, env: {} };

      default:
        return { cancelled: true, env: mergedEnv };
    }
  }

  /**
   * Add a new environment variable
   */
  private async addEnvironmentVariable(
    workflowName: string,
    currentEnv: Record<string, string>
  ): Promise<EnvConfigResult> {
    // Get variable name
    const key = await vscode.window.showInputBox({
      title: 'Add Environment Variable',
      prompt: 'Enter variable name',
      placeHolder: 'MY_VARIABLE',
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'Variable name is required';
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
          return 'Variable name must start with a letter or underscore and contain only alphanumeric characters and underscores';
        }
        return undefined;
      },
    });

    if (!key) {
      return this.showEnvConfiguration(workflowName, currentEnv);
    }

    // Get variable value
    const value = await vscode.window.showInputBox({
      title: `Set value for ${key}`,
      prompt: 'Enter variable value',
      placeHolder: 'value',
    });

    if (value === undefined) {
      return this.showEnvConfiguration(workflowName, currentEnv);
    }

    // Update environment
    const updatedEnv = { ...currentEnv, [key]: value };
    this.savedEnv.set(workflowName, updatedEnv);

    // Show configuration again
    return this.showEnvConfiguration(workflowName, updatedEnv);
  }

  /**
   * Edit existing environment variables
   */
  private async editEnvironmentVariables(
    workflowName: string,
    currentEnv: Record<string, string>
  ): Promise<EnvConfigResult> {
    const entries = Object.entries(currentEnv);

    if (entries.length === 0) {
      vscode.window.showInformationMessage('No environment variables to edit');
      return this.showEnvConfiguration(workflowName, currentEnv);
    }

    // Show list of variables
    const items: (vscode.QuickPickItem & { envKey?: string })[] = entries.map(([key, value]) => ({
      label: key,
      description: this.isSensitiveKey(key) ? '********' : value,
      envKey: key,
    }));

    items.push({
      label: '$(arrow-left) Back',
      description: 'Return to main menu',
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Edit Environment Variables',
      placeHolder: 'Select a variable to edit',
    });

    if (!selected || selected.label === '$(arrow-left) Back') {
      return this.showEnvConfiguration(workflowName, currentEnv);
    }

    if (selected.envKey) {
      return this.editSingleVariable(workflowName, currentEnv, selected.envKey);
    }

    return this.showEnvConfiguration(workflowName, currentEnv);
  }

  /**
   * Edit a single environment variable
   */
  private async editSingleVariable(
    workflowName: string,
    currentEnv: Record<string, string>,
    key: string
  ): Promise<EnvConfigResult> {
    const items: vscode.QuickPickItem[] = [
      {
        label: '$(edit) Edit value',
        description: 'Change the value',
      },
      {
        label: '$(trash) Delete variable',
        description: 'Remove this variable',
      },
      {
        label: '$(arrow-left) Back',
        description: 'Return to variable list',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: `Edit: ${key}`,
      placeHolder: 'Select an action',
    });

    if (!selected || selected.label === '$(arrow-left) Back') {
      return this.editEnvironmentVariables(workflowName, currentEnv);
    }

    if (selected.label === '$(edit) Edit value') {
      const newValue = await vscode.window.showInputBox({
        title: `Edit ${key}`,
        prompt: 'Enter new value',
        value: currentEnv[key],
        password: this.isSensitiveKey(key),
      });

      if (newValue !== undefined) {
        const updatedEnv = { ...currentEnv, [key]: newValue };
        this.savedEnv.set(workflowName, updatedEnv);
        return this.editEnvironmentVariables(workflowName, updatedEnv);
      }
    }

    if (selected.label === '$(trash) Delete variable') {
      const updatedEnv = { ...currentEnv };
      delete updatedEnv[key];
      this.savedEnv.set(workflowName, updatedEnv);
      return this.editEnvironmentVariables(workflowName, updatedEnv);
    }

    return this.editEnvironmentVariables(workflowName, currentEnv);
  }

  /**
   * Get saved environment for a workflow
   */
  public getSavedEnv(workflowName: string): Record<string, string> {
    const saved = this.savedEnv.get(workflowName);
    return saved ? { ...saved } : {};
  }

  /**
   * Save environment for a workflow
   */
  public saveEnv(workflowName: string, env: Record<string, string>): void {
    this.savedEnv.set(workflowName, { ...env });
  }

  /**
   * Clear saved environment for a workflow
   */
  public clearEnv(workflowName: string): void {
    this.savedEnv.delete(workflowName);
  }

  /**
   * Clear all saved environments
   */
  public clearAllEnv(): void {
    this.savedEnv.clear();
  }

  /**
   * Format environment summary for display
   */
  private formatEnvSummary(env: Record<string, string>): string {
    const count = Object.keys(env).length;
    if (count === 0) {
      return 'No custom environment variables';
    }
    return `${count} variable${count !== 1 ? 's' : ''}: ${Object.keys(env).slice(0, 3).join(', ')}${count > 3 ? '...' : ''}`;
  }

  /**
   * Check if a key is sensitive
   */
  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      'password',
      'secret',
      'token',
      'key',
      'api_key',
      'apikey',
      'auth',
      'credential',
    ];
    const lowerKey = key.toLowerCase();
    return sensitivePatterns.some(pattern => lowerKey.includes(pattern));
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.savedEnv.clear();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    EnvConfigManager.instance?.dispose();
    EnvConfigManager.instance = undefined;
  }
}

/**
 * Get the singleton env config manager instance
 */
export function getEnvConfigManager(): EnvConfigManager {
  return EnvConfigManager.getInstance();
}
