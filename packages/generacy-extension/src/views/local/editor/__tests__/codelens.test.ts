/**
 * Tests for the Generacy workflow CodeLens and Code Action providers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  CodeLens: class MockCodeLens {
    constructor(
      public range: unknown,
      public command?: unknown
    ) {}
  },
  Range: class MockRange {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number
    ) {}
  },
  Position: class MockPosition {
    constructor(
      public line: number,
      public character: number
    ) {}
  },
  EventEmitter: class MockEventEmitter {
    private listeners: Array<() => void> = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire = () => {
      this.listeners.forEach((l) => l());
    };
    dispose = () => {
      this.listeners = [];
    };
  },
  CodeActionKind: {
    QuickFix: 'quickfix',
    Refactor: 'refactor',
    RefactorExtract: 'refactor.extract',
  },
  CodeAction: class MockCodeAction {
    constructor(
      public title: string,
      public kind?: string
    ) {}
    diagnostics?: unknown[];
    isPreferred?: boolean;
    edit?: unknown;
    command?: unknown;
  },
  WorkspaceEdit: class MockWorkspaceEdit {
    private edits: Array<{ uri: unknown; edit: unknown }> = [];
    insert(uri: unknown, position: unknown, text: string) {
      this.edits.push({ uri, edit: { type: 'insert', position, text } });
    }
    replace(uri: unknown, range: unknown, text: string) {
      this.edits.push({ uri, edit: { type: 'replace', range, text } });
    }
    delete(uri: unknown, range: unknown) {
      this.edits.push({ uri, edit: { type: 'delete', range } });
    }
    getEdits() {
      return this.edits;
    }
  },
  languages: {
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, path }),
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
}));

// Mock utils
vi.mock('../../../../utils', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock constants - note: patterns simplified for testing
vi.mock('../../../../constants', () => ({
  COMMANDS: {
    validateWorkflow: 'generacy.validateWorkflow',
    runWorkflow: 'generacy.runWorkflow',
    debugWorkflow: 'generacy.debugWorkflow',
  },
  WORKFLOW_FILE_PATTERNS: {
    yaml: '**/.generacy/**/*.yaml',
    yml: '**/.generacy/**/*.yml',
  },
}));

// Helper to check if path matches workflow patterns for testing
function _isWorkflowPath(path: string): boolean {
  return (
    path.includes('.generacy') &&
    (path.endsWith('.yaml') || path.endsWith('.yml'))
  );
}
void _isWorkflowPath; // Suppress unused variable warning

import { WorkflowCodeLensProvider, WorkflowCodeActionProvider } from '../codelens';

describe('WorkflowCodeLensProvider', () => {
  let provider: WorkflowCodeLensProvider;

  beforeEach(() => {
    provider = new WorkflowCodeLensProvider();
  });

  describe('provideCodeLenses', () => {
    it('should return empty array for non-workflow files', () => {
      const document = createMockDocument('/some/other/file.ts', '');
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken());
      expect(codeLenses).toHaveLength(0);
    });

    it('should provide Validate CodeLens at document top', () => {
      const yaml = `
name: test-workflow
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as Array<{
        command?: { title: string };
      }>;

      expect(codeLenses.length).toBeGreaterThan(0);
      const validateLens = codeLenses.find((cl) => cl.command?.title?.includes('Validate'));
      expect(validateLens).toBeDefined();
    });

    it('should provide Run Phase CodeLens above each phase', () => {
      const yaml = `
name: test-workflow
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
  - name: deploy
    steps:
      - name: publish
        run: npm publish
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as Array<{
        command?: { title: string };
      }>;

      const runPhaseLenses = codeLenses.filter((cl) => cl.command?.title?.includes('Run Phase'));
      expect(runPhaseLenses.length).toBe(2);
      expect(runPhaseLenses[0]?.command?.title).toContain('build');
      expect(runPhaseLenses[1]?.command?.title).toContain('deploy');
    });

    it('should provide Debug Step CodeLens above each step', () => {
      const yaml = `
name: test-workflow
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
      - name: test
        run: npm test
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as Array<{
        command?: { title: string };
      }>;

      const debugStepLenses = codeLenses.filter((cl) => cl.command?.title?.includes('Debug Step'));
      expect(debugStepLenses.length).toBe(2);
      expect(debugStepLenses[0]?.command?.title).toContain('compile');
      expect(debugStepLenses[1]?.command?.title).toContain('test');
    });

    it('should handle YAML parse errors gracefully', () => {
      const invalidYaml = `
name: test
version: "1.0.0
phases:
  - name: [invalid
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', invalidYaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as Array<{
        command?: { title: string };
      }>;

      // Should still provide at least the Validate lens
      expect(codeLenses.length).toBeGreaterThanOrEqual(1);
      const validateLens = codeLenses.find((cl) => cl.command?.title?.includes('Validate'));
      expect(validateLens).toBeDefined();
    });

    it('should match .generacy.yaml file pattern', () => {
      const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/my-workflow.generacy.yaml', yaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as unknown[];
      expect(codeLenses.length).toBeGreaterThan(0);
    });

    it('should match .generacy.yml file pattern', () => {
      const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/my-workflow.generacy.yml', yaml);
      const codeLenses = provider.provideCodeLenses(document, createMockCancellationToken()) as unknown[];
      expect(codeLenses.length).toBeGreaterThan(0);
    });
  });

  describe('refresh', () => {
    it('should emit onDidChangeCodeLenses event', () => {
      const listener = vi.fn();
      provider.onDidChangeCodeLenses(listener);
      provider.refresh();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should dispose event emitter', () => {
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});

describe('WorkflowCodeActionProvider', () => {
  let provider: WorkflowCodeActionProvider;

  beforeEach(() => {
    provider = new WorkflowCodeActionProvider();
  });

  describe('providedCodeActionKinds', () => {
    it('should provide QuickFix and Refactor kinds', () => {
      expect(WorkflowCodeActionProvider.providedCodeActionKinds).toContain('quickfix');
      expect(WorkflowCodeActionProvider.providedCodeActionKinds).toContain('refactor');
    });
  });

  describe('provideCodeActions', () => {
    it('should return undefined for non-workflow files', () => {
      const document = createMockDocument('/some/other/file.ts', '');
      const range = { start: { line: 0 }, end: { line: 0 } };
      const context = { diagnostics: [] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeUndefined();
    });

    it('should create fix for missing required field', () => {
      const yaml = `
name: test
version: "1.0.0"
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 2 }, end: { line: 2 } };
      const diagnostic = {
        message: "Required field 'phases' is missing",
        range: { start: { line: 2 }, end: { line: 2 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const addFieldAction = actions?.find((a) => a.title.includes('Add required field'));
      expect(addFieldAction).toBeDefined();
    });

    it('should create fix for invalid name format', () => {
      const yaml = `
name: 123-invalid-name
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 1 }, end: { line: 1 } };
      const diagnostic = {
        message: 'Name must start with a letter',
        range: { start: { line: 1 }, end: { line: 1 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const fixNameAction = actions?.find((a) => a.title.includes('Fix name format'));
      expect(fixNameAction).toBeDefined();
    });

    it('should create fix for invalid version format', () => {
      const yaml = `
name: test
version: v1.0
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 2 }, end: { line: 2 } };
      const diagnostic = {
        message: 'Version must follow semantic versioning',
        range: { start: { line: 2 }, end: { line: 2 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const fixVersionAction = actions?.find((a) => a.title.includes('Fix version format'));
      expect(fixVersionAction).toBeDefined();
    });

    it('should create fix for unrecognized property', () => {
      const yaml = `
name: test
version: "1.0.0"
unknownProp: value
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 3 }, end: { line: 3 } };
      const diagnostic = {
        message: "Unrecognized property 'unknownProp'",
        range: { start: { line: 3 }, end: { line: 3 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const removeAction = actions?.find((a) => a.title.includes('Remove unrecognized'));
      expect(removeAction).toBeDefined();
    });

    it('should create fix for duplicate name', () => {
      const yaml = `name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
  - name: build
    steps:
      - name: deploy
        run: npm publish`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      // Line 7 is "  - name: build" (the duplicate)
      const range = { start: { line: 7 }, end: { line: 7 } };
      const diagnostic = {
        message: 'Duplicate phase name: "build"',
        range: { start: { line: 7 }, end: { line: 7 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const renameAction = actions?.find((a) => a.title.includes('Rename to'));
      expect(renameAction).toBeDefined();
    });

    it('should create fix for step missing uses or run', () => {
      const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: empty-step
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 6 }, end: { line: 6 } };
      const diagnostic = {
        message: 'Step must have either "uses" or "run" defined',
        range: { start: { line: 6 }, end: { line: 6 } },
      };
      const context = { diagnostics: [diagnostic] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const addRunAction = actions?.find((a) => a.title.includes('Add "run" command'));
      expect(addRunAction).toBeDefined();
    });

    it('should create refactor action to add condition on step line', () => {
      const yaml = `
name: test
version: "1.0.0"
phases:
  - name: build
    steps:
      - name: compile
        run: npm run build
`;
      const document = createMockDocument('/project/.generacy/workflow.yaml', yaml);
      const range = { start: { line: 6 }, end: { line: 6 } };
      const context = { diagnostics: [] };

      const actions = provider.provideCodeActions(
        document,
        range as never,
        context as never,
        createMockCancellationToken()
      );

      expect(actions).toBeDefined();
      const addConditionAction = actions?.find((a) => a.title.includes('Add condition'));
      expect(addConditionAction).toBeDefined();
    });
  });
});

// Helper functions

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockDocument(fsPath: string, content: string): any {
  const lines = content.split('\n');
  return {
    uri: { fsPath, path: fsPath },
    getText: () => content,
    lineAt: (line: number) => ({
      text: lines[line] || '',
    }),
    lineCount: lines.length,
  };
}

function createMockCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(),
  };
}
