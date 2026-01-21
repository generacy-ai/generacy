/**
 * Tests for tree-item.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  WorkflowTreeItem,
  PhaseTreeItem,
  StepTreeItem,
  isWorkflowTreeItem,
  isPhaseTreeItem,
  isStepTreeItem,
  ValidationStatus,
  WorkflowItemData,
  PhaseData,
  StepData,
  ParsedWorkflow,
} from '../tree-item';
import { TREE_ITEM_CONTEXT } from '../../../../constants';

// Mock vscode module
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {
    id: string;
    color?: unknown;
    constructor(id: string, color?: unknown) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
    parse: (str: string) => ({ fsPath: str.replace('file://', ''), toString: () => str }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join('/'),
      toString: () => `file://${[base.fsPath, ...segments].join('/')}`,
    }),
  },
  MarkdownString: class {
    private parts: string[] = [];
    appendMarkdown(text: string): this {
      this.parts.push(text);
      return this;
    }
    toString(): string {
      return this.parts.join('');
    }
  },
}));

describe('WorkflowTreeItem', () => {
  const createMockWorkflowData = (overrides: Partial<WorkflowItemData> = {}): WorkflowItemData => ({
    uri: vscode.Uri.file('/test/workflows/my-workflow.yaml'),
    name: 'My Workflow',
    validationStatus: 'unknown' as ValidationStatus,
    ...overrides,
  });

  const createMockParsedWorkflow = (overrides: Partial<ParsedWorkflow> = {}): ParsedWorkflow => ({
    name: 'Test Workflow',
    description: 'A test workflow',
    phases: [],
    rawContent: 'name: Test Workflow',
    ...overrides,
  });

  describe('constructor', () => {
    it('should create a tree item with correct properties', () => {
      const data = createMockWorkflowData();
      const item = new WorkflowTreeItem(data);

      expect(item.label).toBe('My Workflow');
      expect(item.contextValue).toBe(TREE_ITEM_CONTEXT.workflow);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(item.uri).toBe(data.uri);
      expect(item.validationStatus).toBe('unknown');
    });

    it('should set resourceUri for file decorations', () => {
      const data = createMockWorkflowData();
      const item = new WorkflowTreeItem(data);

      expect(item.resourceUri).toBe(data.uri);
    });

    it('should set command to open the workflow file', () => {
      const data = createMockWorkflowData();
      const item = new WorkflowTreeItem(data);

      expect(item.command).toBeDefined();
      expect(item.command?.command).toBe('vscode.open');
      expect(item.command?.arguments).toContain(data.uri);
    });
  });

  describe('validation status', () => {
    it('should display valid status correctly', () => {
      const data = createMockWorkflowData({ validationStatus: 'valid' });
      const item = new WorkflowTreeItem(data);

      expect(item.validationStatus).toBe('valid');
      expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    });

    it('should display invalid status correctly', () => {
      const data = createMockWorkflowData({
        validationStatus: 'invalid',
        validationError: 'Missing required field',
      });
      const item = new WorkflowTreeItem(data);

      expect(item.validationStatus).toBe('invalid');
      expect(item.validationError).toBe('Missing required field');
    });

    it('should update validation status', () => {
      const data = createMockWorkflowData();
      const item = new WorkflowTreeItem(data);

      item.updateValidationStatus('valid');
      expect(item.validationStatus).toBe('valid');
      expect(item.validationError).toBeUndefined();

      item.updateValidationStatus('invalid', 'Test error');
      expect(item.validationStatus).toBe('invalid');
      expect(item.validationError).toBe('Test error');
    });
  });

  describe('phases', () => {
    it('should report hasChildren correctly with no phases', () => {
      const data = createMockWorkflowData();
      const item = new WorkflowTreeItem(data);

      expect(item.hasChildren()).toBe(false);
    });

    it('should report hasChildren correctly with phases', () => {
      const data = createMockWorkflowData();
      const parsedWorkflow = createMockParsedWorkflow({
        phases: [{ name: 'build', label: 'Build', steps: [], index: 0 }],
      });
      const item = new WorkflowTreeItem(data, parsedWorkflow);

      expect(item.hasChildren()).toBe(true);
    });

    it('should return phase items', () => {
      const data = createMockWorkflowData();
      const parsedWorkflow = createMockParsedWorkflow({
        phases: [
          { name: 'build', label: 'Build', steps: [], index: 0 },
          { name: 'test', label: 'Test', steps: [], index: 1 },
        ],
      });
      const item = new WorkflowTreeItem(data, parsedWorkflow);

      const phases = item.getPhaseItems();
      expect(phases).toHaveLength(2);
      expect(phases[0]).toBeInstanceOf(PhaseTreeItem);
      expect(phases[0].label).toBe('Build');
    });
  });
});

describe('PhaseTreeItem', () => {
  const createMockPhaseData = (overrides: Partial<PhaseData> = {}): PhaseData => ({
    name: 'build',
    label: 'Build Phase',
    steps: [],
    index: 0,
    ...overrides,
  });

  const mockWorkflowUri = vscode.Uri.file('/test/workflows/my-workflow.yaml');

  describe('constructor', () => {
    it('should create a tree item with correct properties', () => {
      const phaseData = createMockPhaseData();
      const item = new PhaseTreeItem(phaseData, mockWorkflowUri);

      expect(item.label).toBe('Build Phase');
      expect(item.contextValue).toBe(TREE_ITEM_CONTEXT.phase);
      expect(item.workflowUri).toBe(mockWorkflowUri);
      expect(item.phaseData).toBe(phaseData);
    });

    it('should be collapsed when has steps', () => {
      const phaseData = createMockPhaseData({
        steps: [{ name: 'step1', label: 'Step 1', type: 'script', index: 0 }],
      });
      const item = new PhaseTreeItem(phaseData, mockWorkflowUri);

      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    });

    it('should not be collapsible when has no steps', () => {
      const phaseData = createMockPhaseData({ steps: [] });
      const item = new PhaseTreeItem(phaseData, mockWorkflowUri);

      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it('should show step count in description', () => {
      const phaseData = createMockPhaseData({
        steps: [
          { name: 'step1', label: 'Step 1', type: 'script', index: 0 },
          { name: 'step2', label: 'Step 2', type: 'action', index: 1 },
        ],
      });
      const item = new PhaseTreeItem(phaseData, mockWorkflowUri);

      expect(item.description).toBe('2 steps');
    });
  });

  describe('steps', () => {
    it('should report hasChildren correctly', () => {
      const phaseDataNoSteps = createMockPhaseData({ steps: [] });
      const itemNoSteps = new PhaseTreeItem(phaseDataNoSteps, mockWorkflowUri);
      expect(itemNoSteps.hasChildren()).toBe(false);

      const phaseDataWithSteps = createMockPhaseData({
        steps: [{ name: 'step1', label: 'Step 1', type: 'script', index: 0 }],
      });
      const itemWithSteps = new PhaseTreeItem(phaseDataWithSteps, mockWorkflowUri);
      expect(itemWithSteps.hasChildren()).toBe(true);
    });

    it('should return step items', () => {
      const phaseData = createMockPhaseData({
        steps: [
          { name: 'step1', label: 'Step 1', type: 'script', index: 0 },
          { name: 'step2', label: 'Step 2', type: 'action', index: 1 },
        ],
      });
      const item = new PhaseTreeItem(phaseData, mockWorkflowUri);

      const steps = item.getStepItems();
      expect(steps).toHaveLength(2);
      expect(steps[0]).toBeInstanceOf(StepTreeItem);
      expect(steps[0].label).toBe('Step 1');
    });
  });
});

describe('StepTreeItem', () => {
  const createMockStepData = (overrides: Partial<StepData> = {}): StepData => ({
    name: 'build-step',
    label: 'Build Step',
    type: 'script',
    index: 0,
    ...overrides,
  });

  const mockWorkflowUri = vscode.Uri.file('/test/workflows/my-workflow.yaml');

  describe('constructor', () => {
    it('should create a tree item with correct properties', () => {
      const stepData = createMockStepData();
      const item = new StepTreeItem(stepData, mockWorkflowUri);

      expect(item.label).toBe('Build Step');
      expect(item.contextValue).toBe(TREE_ITEM_CONTEXT.step);
      expect(item.workflowUri).toBe(mockWorkflowUri);
      expect(item.stepData).toBe(stepData);
      expect(item.description).toBe('script');
    });

    it('should not be collapsible', () => {
      const stepData = createMockStepData();
      const item = new StepTreeItem(stepData, mockWorkflowUri);

      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });
  });

  describe('icons', () => {
    it('should show terminal icon for script steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'script' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('terminal');
    });

    it('should show play icon for action steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'action' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('play');
    });

    it('should show compare icon for condition steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'condition' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('git-compare');
    });

    it('should show split icon for parallel steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'parallel' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('split-horizontal');
    });

    it('should show sync icon for loop steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'loop' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('sync');
    });

    it('should show check icon for approval steps', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'approval' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('check');
    });

    it('should show method icon for unknown step types', () => {
      const item = new StepTreeItem(createMockStepData({ type: 'custom' }), mockWorkflowUri);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('symbol-method');
    });
  });
});

describe('Type guards', () => {
  const mockUri = vscode.Uri.file('/test/workflow.yaml');

  it('isWorkflowTreeItem should correctly identify WorkflowTreeItem', () => {
    const workflowItem = new WorkflowTreeItem({
      uri: mockUri,
      name: 'Test',
      validationStatus: 'unknown',
    });
    const phaseItem = new PhaseTreeItem(
      { name: 'phase', label: 'Phase', steps: [], index: 0 },
      mockUri
    );
    const stepItem = new StepTreeItem(
      { name: 'step', label: 'Step', type: 'script', index: 0 },
      mockUri
    );

    expect(isWorkflowTreeItem(workflowItem)).toBe(true);
    expect(isWorkflowTreeItem(phaseItem)).toBe(false);
    expect(isWorkflowTreeItem(stepItem)).toBe(false);
  });

  it('isPhaseTreeItem should correctly identify PhaseTreeItem', () => {
    const workflowItem = new WorkflowTreeItem({
      uri: mockUri,
      name: 'Test',
      validationStatus: 'unknown',
    });
    const phaseItem = new PhaseTreeItem(
      { name: 'phase', label: 'Phase', steps: [], index: 0 },
      mockUri
    );
    const stepItem = new StepTreeItem(
      { name: 'step', label: 'Step', type: 'script', index: 0 },
      mockUri
    );

    expect(isPhaseTreeItem(workflowItem)).toBe(false);
    expect(isPhaseTreeItem(phaseItem)).toBe(true);
    expect(isPhaseTreeItem(stepItem)).toBe(false);
  });

  it('isStepTreeItem should correctly identify StepTreeItem', () => {
    const workflowItem = new WorkflowTreeItem({
      uri: mockUri,
      name: 'Test',
      validationStatus: 'unknown',
    });
    const phaseItem = new PhaseTreeItem(
      { name: 'phase', label: 'Phase', steps: [], index: 0 },
      mockUri
    );
    const stepItem = new StepTreeItem(
      { name: 'step', label: 'Step', type: 'script', index: 0 },
      mockUri
    );

    expect(isStepTreeItem(workflowItem)).toBe(false);
    expect(isStepTreeItem(phaseItem)).toBe(false);
    expect(isStepTreeItem(stepItem)).toBe(true);
  });
});
