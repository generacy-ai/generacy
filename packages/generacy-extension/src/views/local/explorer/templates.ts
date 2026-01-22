/**
 * Template Library - Manages workflow templates for the Generacy extension.
 * Loads templates from bundled resources and provides selection UI support.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getLogger } from '../../../utils';
import { WORKFLOW_TEMPLATES } from '../../../constants';

/**
 * Metadata for a workflow template
 */
export interface TemplateMetadata {
  /** Template identifier (filename without extension) */
  id: string;
  /** Display name for the template */
  name: string;
  /** Short description of the template's purpose */
  description: string;
  /** Longer explanation of when to use this template */
  detail: string;
  /** Icon to display in the quick pick */
  icon: string;
  /** Category for grouping templates */
  category: 'starter' | 'advanced';
}

/**
 * A workflow template with its content
 */
export interface WorkflowTemplate extends TemplateMetadata {
  /** Raw YAML content of the template */
  content: string;
}

/**
 * Built-in template metadata definitions
 */
const TEMPLATE_METADATA: Record<string, Omit<TemplateMetadata, 'id'>> = {
  [WORKFLOW_TEMPLATES.basic]: {
    name: 'Basic',
    description: 'Single phase with simple steps',
    detail: 'Best for simple workflows and getting started',
    icon: '$(file)',
    category: 'starter',
  },
  [WORKFLOW_TEMPLATES.multiPhase]: {
    name: 'Multi-Phase',
    description: 'Setup, build, and deploy phases',
    detail: 'Best for CI/CD and multi-stage workflows',
    icon: '$(layers)',
    category: 'starter',
  },
  [WORKFLOW_TEMPLATES.withTriggers]: {
    name: 'With Triggers',
    description: 'Webhook and schedule triggers',
    detail: 'Best for automated workflows that respond to events',
    icon: '$(zap)',
    category: 'starter',
  },
};

/**
 * TemplateManager provides access to workflow templates bundled with the extension.
 * Templates are loaded from the resources/templates directory.
 */
export class TemplateManager implements vscode.Disposable {
  private extensionUri: vscode.Uri | undefined;
  private templateCache: Map<string, WorkflowTemplate> = new Map();
  private initialized = false;

  /**
   * Initialize the template manager with the extension context
   */
  public initialize(context: vscode.ExtensionContext): void {
    this.extensionUri = context.extensionUri;
    this.initialized = true;
    getLogger().debug('TemplateManager initialized');
  }

  /**
   * Get the URI for the templates directory
   */
  private getTemplatesUri(): vscode.Uri {
    if (!this.extensionUri) {
      throw new Error('TemplateManager not initialized');
    }
    return vscode.Uri.joinPath(this.extensionUri, 'resources', 'templates');
  }

  /**
   * Get all available template metadata
   */
  public getTemplateMetadata(): TemplateMetadata[] {
    return Object.entries(TEMPLATE_METADATA).map(([id, meta]) => ({
      id,
      ...meta,
    }));
  }

  /**
   * Get a template by ID with its content
   */
  public async getTemplate(id: string): Promise<WorkflowTemplate | undefined> {
    const logger = getLogger();

    // Check cache first
    if (this.templateCache.has(id)) {
      return this.templateCache.get(id);
    }

    const metadata = TEMPLATE_METADATA[id];
    if (!metadata) {
      logger.warn(`Unknown template ID: ${id}`);
      return undefined;
    }

    try {
      const content = await this.loadTemplateContent(id);
      const template: WorkflowTemplate = {
        id,
        ...metadata,
        content,
      };

      this.templateCache.set(id, template);
      return template;
    } catch (error) {
      logger.error(`Failed to load template ${id}:`, error);
      return undefined;
    }
  }

  /**
   * Load template content from the resources directory
   */
  private async loadTemplateContent(id: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('TemplateManager not initialized');
    }

    const templatesUri = this.getTemplatesUri();
    const templateUri = vscode.Uri.joinPath(templatesUri, `${id}.yaml`);

    const content = await vscode.workspace.fs.readFile(templateUri);
    return Buffer.from(content).toString('utf-8');
  }

  /**
   * Get all templates with their content (loads if not cached)
   */
  public async getAllTemplates(): Promise<WorkflowTemplate[]> {
    const templates: WorkflowTemplate[] = [];

    for (const id of Object.keys(TEMPLATE_METADATA)) {
      const template = await this.getTemplate(id);
      if (template) {
        templates.push(template);
      }
    }

    return templates;
  }

  /**
   * Create template content customized with a workflow name
   */
  public customizeTemplate(template: WorkflowTemplate, workflowName: string): string {
    return template.content.replace(/^name:\s*.+$/m, `name: ${workflowName}`);
  }

  /**
   * Clear the template cache
   */
  public clearCache(): void {
    this.templateCache.clear();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.clearCache();
  }
}

// Singleton instance
let templateManagerInstance: TemplateManager | undefined;

/**
 * Get the singleton TemplateManager instance
 */
export function getTemplateManager(): TemplateManager {
  if (!templateManagerInstance) {
    templateManagerInstance = new TemplateManager();
  }
  return templateManagerInstance;
}

/**
 * Quick pick item for template selection with preview support
 */
export interface TemplateQuickPickItem extends vscode.QuickPickItem {
  template: TemplateMetadata;
}

/**
 * Create quick pick items from templates
 */
export function createTemplateQuickPickItems(
  templates: TemplateMetadata[]
): TemplateQuickPickItem[] {
  return templates.map((template) => ({
    label: `${template.icon} ${template.name}`,
    description: template.description,
    detail: template.detail,
    template,
  }));
}

/**
 * Show template selection quick pick with preview support
 */
export async function showTemplateQuickPick(
  templates: TemplateMetadata[]
): Promise<TemplateMetadata | undefined> {
  const items = createTemplateQuickPickItems(templates);

  const quickPick = vscode.window.createQuickPick<TemplateQuickPickItem>();
  quickPick.items = items;
  quickPick.placeholder = 'Select a workflow template';
  quickPick.title = 'Create New Workflow';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  // Track the preview document so we can close it
  let previewEditor: vscode.TextEditor | undefined;

  // Show preview when selection changes
  quickPick.onDidChangeActive(async (selected) => {
    if (selected.length === 0) return;

    const item = selected[0];
    if (!item) return;

    try {
      const template = await getTemplateManager().getTemplate(item.template.id);
      if (template) {
        // Create a preview document
        const doc = await vscode.workspace.openTextDocument({
          content: template.content,
          language: 'yaml',
        });

        // Show in preview mode (right side)
        previewEditor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
          preserveFocus: true,
        });
      }
    } catch {
      // Ignore preview errors - selection can still work
    }
  });

  return new Promise((resolve) => {
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();

      // Close preview if open
      if (previewEditor) {
        vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }

      resolve(selected?.template);
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();

      // Close preview if still open
      if (previewEditor) {
        vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }

      resolve(undefined);
    });

    quickPick.show();
  });
}
