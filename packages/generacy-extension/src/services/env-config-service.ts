/**
 * Environment Configuration Service for Generacy VS Code extension.
 *
 * Watches `.generacy/generacy.env` for changes and tracks whether
 * the required environment keys (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`)
 * have non-empty values. Exposes a reactive `onDidChange` event
 * that fires on status transitions (missing ↔ incomplete ↔ ok).
 *
 * Does NOT parse with dotenv — uses simple regex scanning for status checks.
 */
import * as vscode from 'vscode';
import { ENV_FILE_GLOB, ENV_FILE_PATH, ENV_REQUIRED_KEYS } from '../constants';
import { getLogger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/** Status of the environment configuration file. */
export type EnvStatus = 'missing' | 'incomplete' | 'ok';

// ============================================================================
// EnvConfigService
// ============================================================================

export class EnvConfigService implements vscode.Disposable {
  private static instance: EnvConfigService | undefined;

  private _status: EnvStatus = 'missing';
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<EnvStatus>();
  public readonly onDidChange = this._onDidChange.event;

  private constructor() {}

  // ==========================================================================
  // Singleton
  // ==========================================================================

  public static getInstance(): EnvConfigService {
    if (!EnvConfigService.instance) {
      EnvConfigService.instance = new EnvConfigService();
    }
    return EnvConfigService.instance;
  }

  public static resetInstance(): void {
    EnvConfigService.instance?.dispose();
    EnvConfigService.instance = undefined;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Read the env file and set up a FileSystemWatcher for hot reload.
   * Call once during extension activation after workspace is available.
   */
  public async initialize(): Promise<void> {
    const logger = getLogger();
    logger.info('Initializing env config service');

    // Compute initial status from file content
    await this.loadStatus();

    // Watch for creates, changes, and deletes of the env file
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        this.getWorkspaceFolder(),
        ENV_FILE_GLOB,
      ),
    );

    this.disposables.push(
      this.watcher.onDidCreate(() => this.onEnvFileChanged()),
      this.watcher.onDidChange(() => this.onEnvFileChanged()),
      this.watcher.onDidDelete(() => this.onEnvFileDeleted()),
      this.watcher,
    );

    logger.info('Env config service initialized', {
      status: this._status,
    });
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /** Current status of the environment configuration. */
  public get status(): EnvStatus {
    return this._status;
  }

  // ==========================================================================
  // Disposable
  // ==========================================================================

  public dispose(): void {
    this.disposed = true;
    this._onDidChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.watcher = undefined;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  /**
   * Read the env file and compute status from its content.
   * Status is determined by checking whether all required keys
   * have non-empty values using regex line scanning.
   */
  private async loadStatus(): Promise<void> {
    const envUri = this.getEnvUri();
    if (!envUri) {
      this._status = 'missing';
      return;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(envUri);
      const text = Buffer.from(raw).toString('utf-8');
      this._status = this.computeStatus(text);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        this._status = 'missing';
      } else {
        const logger = getLogger();
        logger.warn('Failed to read env config file', {
          error: error instanceof Error ? error.message : String(error),
        });
        this._status = 'missing';
      }
    }
  }

  /**
   * Scan file content for required keys with non-empty values.
   * Uses regex matching — no dotenv dependency needed.
   */
  private computeStatus(content: string): EnvStatus {
    const presentKeys = ENV_REQUIRED_KEYS.filter((key) => {
      const pattern = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm');
      return pattern.test(content);
    });

    if (presentKeys.length === ENV_REQUIRED_KEYS.length) {
      return 'ok';
    }
    return 'incomplete';
  }

  private async onEnvFileChanged(): Promise<void> {
    if (this.disposed) return;
    const logger = getLogger();
    logger.info('Env config file changed, reloading');

    const previousStatus = this._status;
    await this.loadStatus();

    if (this._status !== previousStatus) {
      this._onDidChange.fire(this._status);
    }
  }

  private onEnvFileDeleted(): void {
    if (this.disposed) return;
    const logger = getLogger();
    logger.info('Env config file deleted');

    const previousStatus = this._status;
    this._status = 'missing';

    if (this._status !== previousStatus) {
      this._onDidChange.fire(this._status);
    }
  }

  private getWorkspaceFolder(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0]!.uri;
    }
    // Fallback (shouldn't happen — extension activates on workspace)
    return vscode.Uri.file('.');
  }

  private getEnvUri(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return vscode.Uri.joinPath(folders[0]!.uri, ENV_FILE_PATH);
  }
}

/**
 * Get the singleton EnvConfigService instance.
 */
export function getEnvConfigService(): EnvConfigService {
  return EnvConfigService.getInstance();
}
