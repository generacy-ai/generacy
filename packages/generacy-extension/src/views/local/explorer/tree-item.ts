/**
 * Tree item classes for the Workflow Explorer.
 * Defines tree items for workflows, phases, and steps.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TREE_ITEM_CONTEXT } from '../../../constants';

/**
 * Validation status for workflow items
 */
export type ValidationStatus = 'valid' | 'invalid' | 'unknown' | 'validating';

/**
 * Base interface for workflow tree item data
 */
export interface WorkflowItemData {
  /** URI of the workflow file */
  uri: vscode.Uri;
  /** Display name */
  name: string;
  /** Validation status */
  validationStatus: ValidationStatus;
  /** Validation error message, if any */
  validationError?: string;
}

/**
 * Phase data within a workflow
 */
export interface PhaseData {
  /** Phase name/identifier */
  name: string;
  /** Display label */
  label: string;
  /** Steps within this phase */
  steps: StepData[];
  /** Phase index (order in workflow) */
  index: number;
}

/**
 * Step data within a phase
 */
export interface StepData {
  /** Step name/identifier */
  name: string;
  /** Display label */
  label: string;
  /** Step type (e.g., 'script', 'action', 'condition') */
  type: string;
  /** Step index within phase */
  index: number;
}

/**
 * Parsed workflow structure
 */
export interface ParsedWorkflow {
  /** Workflow name from file */
  name: string;
  /** Workflow description */
  description?: string;
  /** Phases in the workflow */
  phases: PhaseData[];
  /** Raw YAML content */
  rawContent: string;
}

/**
 * Base tree item for workflow explorer
 */
abstract class BaseWorkflowTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Tree item representing a workflow file
 */
export class WorkflowTreeItem extends BaseWorkflowTreeItem {
  public readonly uri: vscode.Uri;
  public validationStatus: ValidationStatus;
  public validationError?: string;
  public parsedWorkflow?: ParsedWorkflow;

  constructor(data: WorkflowItemData, parsedWorkflow?: ParsedWorkflow) {
    super(
      data.name,
      vscode.TreeItemCollapsibleState.Collapsed,
      TREE_ITEM_CONTEXT.workflow
    );

    this.uri = data.uri;
    this.validationStatus = data.validationStatus;
    this.validationError = data.validationError;
    this.parsedWorkflow = parsedWorkflow;

    // Set resource URI for file decorations
    this.resourceUri = data.uri;

    // Set icon based on validation status
    this.iconPath = this.getStatusIcon();

    // Set tooltip
    this.tooltip = this.getTooltip();

    // Set description (shown next to label)
    this.description = path.basename(data.uri.fsPath);

    // Command to open workflow file when clicked
    this.command = {
      command: 'vscode.open',
      title: 'Open Workflow',
      arguments: [data.uri],
    };
  }

  /**
   * Get icon based on validation status
   */
  private getStatusIcon(): vscode.ThemeIcon {
    switch (this.validationStatus) {
      case 'valid':
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      case 'invalid':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
      case 'validating':
        return new vscode.ThemeIcon('sync~spin');
      case 'unknown':
      default:
        return new vscode.ThemeIcon('file-code');
    }
  }

  /**
   * Get tooltip text
   */
  private getTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.label}**\n\n`);
    md.appendMarkdown(`Path: \`${this.uri.fsPath}\`\n\n`);

    if (this.parsedWorkflow?.description) {
      md.appendMarkdown(`${this.parsedWorkflow.description}\n\n`);
    }

    const statusText = this.validationStatus === 'valid'
      ? '$(pass) Valid'
      : this.validationStatus === 'invalid'
        ? '$(error) Invalid'
        : this.validationStatus === 'validating'
          ? '$(sync~spin) Validating...'
          : '$(question) Unknown';

    md.appendMarkdown(`Status: ${statusText}\n`);

    if (this.validationError) {
      md.appendMarkdown(`\n---\n**Error:** ${this.validationError}`);
    }

    return md;
  }

  /**
   * Update validation status
   */
  public updateValidationStatus(status: ValidationStatus, error?: string): void {
    this.validationStatus = status;
    this.validationError = error;
    this.iconPath = this.getStatusIcon();
    this.tooltip = this.getTooltip();
  }

  /**
   * Check if this workflow has phases to display
   */
  public hasChildren(): boolean {
    return (this.parsedWorkflow?.phases?.length ?? 0) > 0;
  }

  /**
   * Get the child phase items
   */
  public getPhaseItems(): PhaseTreeItem[] {
    if (!this.parsedWorkflow?.phases) {
      return [];
    }

    return this.parsedWorkflow.phases.map(
      (phase) => new PhaseTreeItem(phase, this.uri)
    );
  }
}

/**
 * Tree item representing a phase within a workflow
 */
export class PhaseTreeItem extends BaseWorkflowTreeItem {
  public readonly workflowUri: vscode.Uri;
  public readonly phaseData: PhaseData;

  constructor(phase: PhaseData, workflowUri: vscode.Uri) {
    super(
      phase.label || phase.name,
      phase.steps.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      TREE_ITEM_CONTEXT.phase
    );

    this.workflowUri = workflowUri;
    this.phaseData = phase;

    // Set icon
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');

    // Set description with step count
    this.description = `${phase.steps.length} step${phase.steps.length !== 1 ? 's' : ''}`;

    // Set tooltip
    this.tooltip = new vscode.MarkdownString()
      .appendMarkdown(`**Phase: ${phase.name}**\n\n`)
      .appendMarkdown(`Steps: ${phase.steps.length}`);
  }

  /**
   * Check if this phase has steps to display
   */
  public hasChildren(): boolean {
    return this.phaseData.steps.length > 0;
  }

  /**
   * Get the child step items
   */
  public getStepItems(): StepTreeItem[] {
    return this.phaseData.steps.map(
      (step) => new StepTreeItem(step, this.workflowUri)
    );
  }
}

/**
 * Tree item representing a step within a phase
 */
export class StepTreeItem extends BaseWorkflowTreeItem {
  public readonly workflowUri: vscode.Uri;
  public readonly stepData: StepData;

  constructor(step: StepData, workflowUri: vscode.Uri) {
    super(
      step.label || step.name,
      vscode.TreeItemCollapsibleState.None,
      TREE_ITEM_CONTEXT.step
    );

    this.workflowUri = workflowUri;
    this.stepData = step;

    // Set icon based on step type
    this.iconPath = this.getStepIcon(step.type);

    // Set description with step type
    this.description = step.type;

    // Set tooltip
    this.tooltip = new vscode.MarkdownString()
      .appendMarkdown(`**Step: ${step.name}**\n\n`)
      .appendMarkdown(`Type: \`${step.type}\``);
  }

  /**
   * Get icon based on step type
   */
  private getStepIcon(type: string): vscode.ThemeIcon {
    switch (type.toLowerCase()) {
      case 'script':
        return new vscode.ThemeIcon('terminal');
      case 'action':
        return new vscode.ThemeIcon('play');
      case 'condition':
        return new vscode.ThemeIcon('git-compare');
      case 'parallel':
        return new vscode.ThemeIcon('split-horizontal');
      case 'loop':
        return new vscode.ThemeIcon('sync');
      case 'approval':
        return new vscode.ThemeIcon('check');
      default:
        return new vscode.ThemeIcon('symbol-method');
    }
  }
}

/**
 * Type guard for WorkflowTreeItem
 */
export function isWorkflowTreeItem(item: vscode.TreeItem): item is WorkflowTreeItem {
  return item.contextValue === TREE_ITEM_CONTEXT.workflow;
}

/**
 * Type guard for PhaseTreeItem
 */
export function isPhaseTreeItem(item: vscode.TreeItem): item is PhaseTreeItem {
  return item.contextValue === TREE_ITEM_CONTEXT.phase;
}

/**
 * Type guard for StepTreeItem
 */
export function isStepTreeItem(item: vscode.TreeItem): item is StepTreeItem {
  return item.contextValue === TREE_ITEM_CONTEXT.step;
}

/**
 * Union type for all workflow tree items
 */
export type WorkflowExplorerItem = WorkflowTreeItem | PhaseTreeItem | StepTreeItem;
