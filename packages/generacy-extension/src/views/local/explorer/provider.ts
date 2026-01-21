/**
 * WorkflowTreeProvider - Tree data provider for the Workflow Explorer view.
 * Provides workflow files with file system watching and validation integration.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'yaml';
import { getConfig, getLogger, ErrorCode, GeneracyError } from '../../../utils';
import { VIEWS } from '../../../constants';
import {
  WorkflowTreeItem,
  PhaseTreeItem,
  StepTreeItem,
  WorkflowExplorerItem,
  ParsedWorkflow,
  PhaseData,
  StepData,
  isWorkflowTreeItem,
  isPhaseTreeItem,
} from './tree-item';

/**
 * WorkflowTreeProvider implements TreeDataProvider for workflow files.
 *
 * Features:
 * - File system watching for automatic refresh
 * - Lazy loading of workflow content
 * - Validation status tracking
 * - Hierarchical display (workflow > phases > steps)
 */
export class WorkflowTreeProvider
  implements vscode.TreeDataProvider<WorkflowExplorerItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    WorkflowExplorerItem | undefined | null | void
  >();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly workflowCache = new Map<string, WorkflowTreeItem>();
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private isRefreshing = false;

  constructor() {
    const logger = getLogger();
    logger.debug('WorkflowTreeProvider initialized');

    // Set up file system watcher
    this.setupFileWatcher();

    // Listen for configuration changes to update watcher
    const config = getConfig();
    this.disposables.push(
      config.onDidChange((event) => {
        if (event.key === 'workflowDirectory') {
          logger.info('Workflow directory changed, resetting file watcher');
          this.setupFileWatcher();
          this.refresh();
        }
      })
    );
  }

  /**
   * Set up the file system watcher for workflow files
   */
  private setupFileWatcher(): void {
    const logger = getLogger();

    // Dispose existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    const config = getConfig();
    const workflowDir = config.get('workflowDirectory');

    // Create glob pattern for workflow files
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      `${workflowDir}/**/*.{yaml,yml}`
    );

    logger.debug(`Setting up file watcher with pattern: ${pattern.pattern}`);

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Handle file events
    this.fileWatcher.onDidCreate((uri) => {
      logger.debug(`Workflow file created: ${uri.fsPath}`);
      this.handleFileChange(uri, 'create');
    });

    this.fileWatcher.onDidChange((uri) => {
      logger.debug(`Workflow file changed: ${uri.fsPath}`);
      this.handleFileChange(uri, 'change');
    });

    this.fileWatcher.onDidDelete((uri) => {
      logger.debug(`Workflow file deleted: ${uri.fsPath}`);
      this.handleFileChange(uri, 'delete');
    });

    this.disposables.push(this.fileWatcher);
  }

  /**
   * Handle file system changes
   */
  private handleFileChange(
    uri: vscode.Uri,
    changeType: 'create' | 'change' | 'delete'
  ): void {
    const key = uri.toString();

    if (changeType === 'delete') {
      // Remove from cache and refresh
      this.workflowCache.delete(key);
      this._onDidChangeTreeData.fire();
    } else if (changeType === 'create') {
      // New file, refresh tree
      this._onDidChangeTreeData.fire();
    } else {
      // File changed, invalidate cache entry and refresh that item
      const cachedItem = this.workflowCache.get(key);
      if (cachedItem) {
        // Mark as needing revalidation
        cachedItem.updateValidationStatus('unknown');
        this.workflowCache.delete(key);
      }
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Get tree item for display
   */
  public getTreeItem(element: WorkflowExplorerItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a tree item
   */
  public async getChildren(
    element?: WorkflowExplorerItem
  ): Promise<WorkflowExplorerItem[]> {
    // Root level: get all workflow files
    if (!element) {
      return this.getWorkflowFiles();
    }

    // Workflow level: get phases
    if (isWorkflowTreeItem(element)) {
      if (!element.parsedWorkflow) {
        // Parse the workflow if not already parsed
        await this.parseWorkflowContent(element);
      }
      return element.getPhaseItems();
    }

    // Phase level: get steps
    if (isPhaseTreeItem(element)) {
      return element.getStepItems();
    }

    // Steps have no children
    return [];
  }

  /**
   * Get parent of a tree item (for reveal support)
   */
  public getParent(element: WorkflowExplorerItem): WorkflowExplorerItem | undefined {
    if (element instanceof StepTreeItem) {
      // Find the phase containing this step
      for (const workflowItem of this.workflowCache.values()) {
        if (workflowItem.uri.toString() === element.workflowUri.toString()) {
          for (const phaseItem of workflowItem.getPhaseItems()) {
            if (
              phaseItem.phaseData.steps.some((s) => s.name === element.stepData.name)
            ) {
              return phaseItem;
            }
          }
        }
      }
    }

    if (element instanceof PhaseTreeItem) {
      // Find the workflow containing this phase
      for (const workflowItem of this.workflowCache.values()) {
        if (workflowItem.uri.toString() === element.workflowUri.toString()) {
          return workflowItem;
        }
      }
    }

    return undefined;
  }

  /**
   * Get all workflow files in the workspace
   */
  private async getWorkflowFiles(): Promise<WorkflowTreeItem[]> {
    const logger = getLogger();
    const config = getConfig();
    const workflowDir = config.get('workflowDirectory');

    if (!vscode.workspace.workspaceFolders?.length) {
      logger.warn('No workspace folder open');
      return [];
    }

    const workspaceFolder = vscode.workspace.workspaceFolders[0]!;
    const workflowDirUri = vscode.Uri.joinPath(workspaceFolder.uri, workflowDir);

    try {
      // Check if workflow directory exists
      try {
        await vscode.workspace.fs.stat(workflowDirUri);
      } catch {
        // Directory doesn't exist, return empty
        logger.debug(`Workflow directory does not exist: ${workflowDirUri.fsPath}`);
        return [];
      }

      // Find all YAML files in the workflow directory
      const pattern = new vscode.RelativePattern(workflowDirUri, '**/*.{yaml,yml}');
      const files = await vscode.workspace.findFiles(pattern);

      logger.debug(`Found ${files.length} workflow files`);

      const items: WorkflowTreeItem[] = [];

      for (const uri of files) {
        const key = uri.toString();

        // Check cache first
        let item = this.workflowCache.get(key);

        if (!item) {
          // Create new item
          const name = this.getWorkflowName(uri);
          item = new WorkflowTreeItem({
            uri,
            name,
            validationStatus: 'unknown',
          });
          this.workflowCache.set(key, item);

          // Parse and validate in background
          this.parseAndValidateWorkflow(item).catch((error) => {
            logger.error(`Error parsing workflow ${uri.fsPath}:`, error);
          });
        }

        items.push(item);
      }

      // Sort by name
      items.sort((a, b) => (a.label as string).localeCompare(b.label as string));

      return items;
    } catch (error) {
      logger.error('Error getting workflow files:', error);
      return [];
    }
  }

  /**
   * Extract workflow name from file URI
   */
  private getWorkflowName(uri: vscode.Uri): string {
    const basename = path.basename(uri.fsPath);
    // Remove extension
    const name = basename.replace(/\.(yaml|yml)$/i, '');
    // Convert to title case
    return name
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Parse workflow file content
   */
  private async parseWorkflowContent(item: WorkflowTreeItem): Promise<void> {
    const logger = getLogger();

    try {
      const content = await vscode.workspace.fs.readFile(item.uri);
      const text = Buffer.from(content).toString('utf-8');

      const parsed = this.parseYamlWorkflow(text, item.uri);
      item.parsedWorkflow = parsed;

      // Update collapsible state based on whether it has phases
      if (parsed.phases.length > 0) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      } else {
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      }
    } catch (error) {
      logger.error(`Error parsing workflow ${item.uri.fsPath}:`, error);
      item.updateValidationStatus('invalid', String(error));
    }
  }

  /**
   * Parse and validate a workflow file
   */
  private async parseAndValidateWorkflow(item: WorkflowTreeItem): Promise<void> {
    item.updateValidationStatus('validating');
    this._onDidChangeTreeData.fire(item);

    try {
      // Read and parse the file
      await this.parseWorkflowContent(item);

      if (item.parsedWorkflow) {
        // Basic validation - check required fields
        const errors = this.validateWorkflow(item.parsedWorkflow);

        if (errors.length > 0) {
          item.updateValidationStatus('invalid', errors.join('; '));
        } else {
          item.updateValidationStatus('valid');
        }
      } else {
        item.updateValidationStatus('invalid', 'Failed to parse workflow');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      item.updateValidationStatus('invalid', message);
    }

    this._onDidChangeTreeData.fire(item);
  }

  /**
   * Parse YAML content into workflow structure
   */
  private parseYamlWorkflow(content: string, uri: vscode.Uri): ParsedWorkflow {
    const doc = yaml.parse(content);

    if (!doc || typeof doc !== 'object') {
      throw new GeneracyError(
        ErrorCode.WorkflowParseError,
        'Invalid workflow: root must be an object'
      );
    }

    const name = doc.name || this.getWorkflowName(uri);
    const description = doc.description;

    // Parse phases
    const phases: PhaseData[] = [];

    if (doc.phases && Array.isArray(doc.phases)) {
      doc.phases.forEach((phase: unknown, phaseIndex: number) => {
        if (typeof phase === 'object' && phase !== null) {
          const phaseObj = phase as Record<string, unknown>;
          const phaseName = (phaseObj.name as string) || `phase-${phaseIndex + 1}`;
          const phaseLabel = (phaseObj.label as string) || phaseName;

          const steps: StepData[] = [];

          if (phaseObj.steps && Array.isArray(phaseObj.steps)) {
            (phaseObj.steps as unknown[]).forEach(
              (step: unknown, stepIndex: number) => {
                if (typeof step === 'object' && step !== null) {
                  const stepObj = step as Record<string, unknown>;
                  const stepName =
                    (stepObj.name as string) || `step-${stepIndex + 1}`;
                  const stepLabel = (stepObj.label as string) || stepName;
                  const stepType = (stepObj.type as string) || 'action';

                  steps.push({
                    name: stepName,
                    label: stepLabel,
                    type: stepType,
                    index: stepIndex,
                  });
                }
              }
            );
          }

          phases.push({
            name: phaseName,
            label: phaseLabel,
            steps,
            index: phaseIndex,
          });
        }
      });
    }

    return {
      name,
      description,
      phases,
      rawContent: content,
    };
  }

  /**
   * Validate parsed workflow structure
   */
  private validateWorkflow(workflow: ParsedWorkflow): string[] {
    const errors: string[] = [];

    if (!workflow.name || workflow.name.trim() === '') {
      errors.push('Workflow name is required');
    }

    // Additional validation can be added here
    // For now, basic structure validation

    return errors;
  }

  /**
   * Refresh the tree view
   */
  public refresh(item?: WorkflowExplorerItem): void {
    const logger = getLogger();

    if (this.isRefreshing) {
      logger.debug('Refresh already in progress, skipping');
      return;
    }

    this.isRefreshing = true;

    if (!item) {
      // Full refresh - clear cache
      logger.info('Refreshing workflow explorer (full)');
      this.workflowCache.clear();
    } else if (item instanceof WorkflowTreeItem) {
      // Refresh specific workflow
      logger.info(`Refreshing workflow: ${item.uri.fsPath}`);
      this.workflowCache.delete(item.uri.toString());
    }

    this._onDidChangeTreeData.fire(item);

    // Reset flag after a short delay
    setTimeout(() => {
      this.isRefreshing = false;
    }, 100);
  }

  /**
   * Reveal a specific workflow in the tree
   */
  public async revealWorkflow(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const item = this.workflowCache.get(key);

    if (item) {
      // The reveal command should be called from the tree view
      // This method prepares the item for reveal
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Get a workflow item by URI
   */
  public getWorkflowByUri(uri: vscode.Uri): WorkflowTreeItem | undefined {
    return this.workflowCache.get(uri.toString());
  }

  /**
   * Get all cached workflows
   */
  public getAllWorkflows(): WorkflowTreeItem[] {
    return Array.from(this.workflowCache.values());
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.workflowCache.clear();
  }
}

/**
 * Factory function to create and register the workflow tree provider
 */
export function createWorkflowTreeProvider(
  context: vscode.ExtensionContext
): WorkflowTreeProvider {
  const provider = new WorkflowTreeProvider();

  // Register the tree data provider
  const treeView = vscode.window.createTreeView(VIEWS.workflows, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  // Add to disposables
  context.subscriptions.push(provider);
  context.subscriptions.push(treeView);

  return provider;
}
