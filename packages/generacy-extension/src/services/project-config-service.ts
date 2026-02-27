/**
 * Project Configuration Service for Generacy VS Code extension.
 *
 * Parses `.generacy/config.yaml` from the first workspace folder, validates
 * against a Zod schema, and watches for file changes to automatically reload.
 * Exposes typed getters and an `onDidChange` event for downstream consumers
 * (status bar, notification filtering, queue scoping).
 */
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PROJECT_CONFIG_FILE, PROJECT_CONFIG_GLOB } from '../constants';
import { getLogger } from '../utils/logger';

// ============================================================================
// Schema
// ============================================================================

const ProjectConfigSchema = z
  .object({
    project: z.object({
      id: z.string(),
      name: z.string(),
    }),
    repos: z
      .object({
        primary: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

// ============================================================================
// Types
// ============================================================================

/** Validated project configuration from `.generacy/config.yaml` */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ============================================================================
// ProjectConfigService
// ============================================================================

export class ProjectConfigService implements vscode.Disposable {
  private static instance: ProjectConfigService | undefined;

  private config: ProjectConfig | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<ProjectConfig | undefined>();
  public readonly onDidChange = this._onDidChange.event;

  private constructor() {}

  // ==========================================================================
  // Singleton
  // ==========================================================================

  public static getInstance(): ProjectConfigService {
    if (!ProjectConfigService.instance) {
      ProjectConfigService.instance = new ProjectConfigService();
    }
    return ProjectConfigService.instance;
  }

  public static resetInstance(): void {
    ProjectConfigService.instance?.dispose();
    ProjectConfigService.instance = undefined;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Read the config file and set up a FileSystemWatcher for hot reload.
   * Call once during extension activation after workspace is available.
   */
  public async initialize(): Promise<void> {
    const logger = getLogger();
    logger.info('Initializing project config service');

    // Parse the config file (may result in `undefined` if absent/invalid)
    await this.loadConfig();

    // Watch for creates, changes, and deletes of the config file
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        this.getWorkspaceFolder(),
        PROJECT_CONFIG_GLOB,
      ),
    );

    this.disposables.push(
      this.watcher.onDidCreate(() => this.onConfigFileChanged()),
      this.watcher.onDidChange(() => this.onConfigFileChanged()),
      this.watcher.onDidDelete(() => this.onConfigFileDeleted()),
      this.watcher,
    );

    logger.info('Project config service initialized', {
      isConfigured: this.isConfigured,
      projectName: this.projectName,
    });
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /** The parsed project ID, or `undefined` when no valid config exists. */
  public get projectId(): string | undefined {
    return this.config?.project.id;
  }

  /** The parsed project name, or `undefined` when no valid config exists. */
  public get projectName(): string | undefined {
    return this.config?.project.name;
  }

  /** The primary repository identifier from the config, if specified. */
  public get reposPrimary(): string | undefined {
    return this.config?.repos?.primary;
  }

  /** `true` when a valid `.generacy/config.yaml` has been loaded. */
  public get isConfigured(): boolean {
    return this.config !== undefined;
  }

  /** The full validated config, or `undefined`. */
  public get currentConfig(): ProjectConfig | undefined {
    return this.config;
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
    this.config = undefined;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async loadConfig(): Promise<void> {
    const logger = getLogger();
    const configUri = this.getConfigUri();
    if (!configUri) {
      this.config = undefined;
      return;
    }

    try {
      const raw = await vscode.workspace.fs.readFile(configUri);
      const text = Buffer.from(raw).toString('utf-8');
      const parsed: unknown = parseYaml(text);
      const result = ProjectConfigSchema.safeParse(parsed);

      if (result.success) {
        this.config = result.data;
      } else {
        logger.warn('Invalid project config — Zod validation failed', {
          errors: result.error.issues.map((i) => i.message),
        });
        vscode.window.showWarningMessage(
          'Generacy: .generacy/config.yaml has invalid format. Some features may be unavailable.',
        );
        this.config = undefined;
      }
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        // No config file — expected for non-Generacy projects
        this.config = undefined;
      } else {
        logger.warn('Failed to read project config', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.config = undefined;
      }
    }
  }

  private async onConfigFileChanged(): Promise<void> {
    if (this.disposed) return;
    const logger = getLogger();
    logger.info('Project config file changed, reloading');

    await this.loadConfig();
    this._onDidChange.fire(this.config);
  }

  private onConfigFileDeleted(): void {
    if (this.disposed) return;
    const logger = getLogger();
    logger.info('Project config file deleted');

    this.config = undefined;
    this._onDidChange.fire(undefined);
  }

  private getWorkspaceFolder(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0]!.uri;
    }
    // Fallback (shouldn't happen — extension activates on workspace)
    return vscode.Uri.file('.');
  }

  private getConfigUri(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return vscode.Uri.joinPath(folders[0]!.uri, PROJECT_CONFIG_FILE);
  }
}

/**
 * Get the singleton ProjectConfigService instance.
 */
export function getProjectConfigService(): ProjectConfigService {
  return ProjectConfigService.getInstance();
}
