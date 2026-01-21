/**
 * Tests for the workflow diagnostic provider
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock vscode before any module imports it
vi.mock('vscode', () => ({
  languages: {
    createDiagnosticCollection: vi.fn(() => ({
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    textDocuments: [],
    fs: {
      readFile: vi.fn().mockResolvedValue(Buffer.from('')),
    },
  },
  window: {
    showInformationMessage: vi.fn(),
    activeTextEditor: null,
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Diagnostic: class MockDiagnostic {
    range: any;
    message: string;
    severity: number;
    source?: string;
    code?: string;
    relatedInformation?: any[];

    constructor(range: any, message: string, severity: number) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  DiagnosticRelatedInformation: class MockRelatedInfo {
    location: any;
    message: string;

    constructor(location: any, message: string) {
      this.location = location;
      this.message = message;
    }
  },
  Location: class MockLocation {
    uri: any;
    range: any;

    constructor(uri: any, range: any) {
      this.uri = uri;
      this.range = range;
    }
  },
  Range: class MockRange {
    start: { line: number; character: number };
    end: { line: number; character: number };

    constructor(
      startLine: number | { line: number; character: number },
      startChar?: number | { line: number; character: number },
      endLine?: number,
      endChar?: number
    ) {
      if (typeof startLine === 'object') {
        this.start = startLine;
        this.end = startChar as { line: number; character: number };
      } else {
        this.start = { line: startLine, character: startChar as number };
        this.end = { line: endLine!, character: endChar! };
      }
    }
  },
  Position: class MockPosition {
    line: number;
    character: number;

    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => path }),
  },
  Disposable: {
    from: (..._args: any[]) => ({ dispose: vi.fn() }),
  },
}));

// Mock utils
vi.mock('../../../../utils', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  GeneracyError: class {
    static from(err: unknown, code: string, message: string) {
      return new Error(message);
    }
  },
  ErrorCode: {
    FileReadError: 'FILE_READ_ERROR',
  },
}));

// Mock constants
vi.mock('../../../../constants', () => ({
  LANGUAGE_IDS: {
    workflow: 'generacy-workflow',
    yaml: 'yaml',
  },
  WORKFLOW_FILE_PATTERNS: {
    yaml: '**/.generacy/**/*.yaml',
    yml: '**/.generacy/**/*.yml',
  },
}));

// Define ValidationSeverity enum
const ValidationSeverity = {
  Error: 'error',
  Warning: 'warning',
  Info: 'info',
  Hint: 'hint',
} as const;

// Mock validator with inline implementation
vi.mock('../../../../language/validator', () => ({
  validateWorkflowFull: vi.fn((content: string) => {
    // Return a simple validation result
    if (content.includes('name:') && content.includes('version:') && content.includes('phases:')) {
      return { valid: true, errors: [] };
    }
    return {
      valid: false,
      errors: [
        {
          message: 'Workflow must have at least one phase',
          path: ['phases'],
          severity: 'error',
        },
      ],
    };
  }),
  ValidationSeverity: {
    Error: 'error',
    Warning: 'warning',
    Info: 'info',
    Hint: 'hint',
  },
}));

// Now import the module under test
import { WorkflowDiagnosticProvider, validateDocument } from '../diagnostics';

describe('WorkflowDiagnosticProvider', () => {
  let provider: WorkflowDiagnosticProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WorkflowDiagnosticProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('constructor', () => {
    it('should create diagnostic collection', async () => {
      const vscode = await import('vscode');
      expect(vscode.languages.createDiagnosticCollection).toHaveBeenCalledWith('generacy');
    });

    it('should subscribe to document events', async () => {
      const vscode = await import('vscode');
      expect(vscode.workspace.onDidOpenTextDocument).toHaveBeenCalled();
      expect(vscode.workspace.onDidChangeTextDocument).toHaveBeenCalled();
      expect(vscode.workspace.onDidCloseTextDocument).toHaveBeenCalled();
      expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalled();
    });
  });

  describe('validateDocument', () => {
    it('should clear diagnostics for empty document', async () => {
      const document = createMockDocument('');
      provider.validateDocument(document as any);

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.set).toHaveBeenCalledWith(document.uri, []);
    });

    it('should set diagnostics for invalid workflow', async () => {
      const document = createMockDocument('name: test\nversion: 1.0.0');
      provider.validateDocument(document as any);

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.set).toHaveBeenCalled();
    });

    it('should clear diagnostics for valid workflow', async () => {
      const validYaml = `
name: test-workflow
version: 1.0.0
phases:
  - name: test
    steps:
      - name: step1
        run: echo hello
`;
      const document = createMockDocument(validYaml);
      provider.validateDocument(document as any);

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.set).toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('should clear all diagnostics', async () => {
      provider.clearAll();

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.clear).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should clear diagnostics for specific URI', async () => {
      const uri = { fsPath: '/test/workflow.yaml', toString: () => '/test/workflow.yaml' };
      provider.clear(uri as any);

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.delete).toHaveBeenCalledWith(uri);
    });
  });

  describe('dispose', () => {
    it('should dispose diagnostic collection', async () => {
      provider.dispose();

      const vscode = await import('vscode');
      const mockCollection = vi.mocked(vscode.languages.createDiagnosticCollection).mock.results[0]?.value;
      expect(mockCollection?.dispose).toHaveBeenCalled();
    });
  });
});

describe('validateDocument function', () => {
  it('should return validation result for document', () => {
    const document = createMockDocument('name: test');
    const result = validateDocument(document as any);

    expect(result).toBeDefined();
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
  });
});

/**
 * Creates a mock VS Code TextDocument
 */
function createMockDocument(content: string) {
  const lines = content.split('\n');

  return {
    getText: () => content,
    lineAt: (line: number) => ({
      text: lines[line] || '',
      lineNumber: line,
    }),
    languageId: 'generacy-workflow',
    uri: { fsPath: '/test/workflow.yaml', toString: () => '/test/workflow.yaml' },
  };
}
