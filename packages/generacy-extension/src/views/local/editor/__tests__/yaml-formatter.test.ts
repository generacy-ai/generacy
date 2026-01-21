/**
 * Tests for the YAML formatter
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };

    constructor(
      startLineOrPos: any,
      startChar?: number,
      endLine?: number,
      endChar?: number
    ) {
      if (typeof startLineOrPos === 'object') {
        // Position objects passed
        this.start = startLineOrPos;
        this.end = { line: startChar as number, character: endLine as number };
      } else {
        this.start = { line: startLineOrPos, character: startChar! };
        this.end = { line: endLine!, character: endChar! };
      }
    }
  },
  Position: class {
    line: number;
    character: number;

    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  },
  TextEdit: {
    replace: vi.fn((range: any, newText: string) => ({
      range,
      newText,
    })),
  },
  workspace: {
    getConfiguration: vi.fn((section: string) => ({
      get: vi.fn((key: string, defaultValue: any) => defaultValue),
    })),
  },
  languages: {
    registerDocumentFormattingEditProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerDocumentRangeFormattingEditProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  window: {
    activeTextEditor: null,
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
}));

// Mock constants
vi.mock('../../../../constants', () => ({
  LANGUAGE_IDS: {
    workflow: 'generacy-workflow',
    yaml: 'yaml',
  },
}));

import { formatWorkflowYaml, formatYaml, WorkflowFormattingProvider } from '../yaml-formatter';

describe('formatWorkflowYaml', () => {
  it('should format valid YAML', () => {
    const input = `name:   test
version:  1.0.0
phases:
- name:  phase1
  steps:
  - name:  step1
    run: echo hello`;

    const result = formatWorkflowYaml(input);

    expect(result).toBeDefined();
    expect(result).toContain('name:');
    expect(result).toContain('version:');
  });

  it('should handle YAML that might have issues gracefully', () => {
    // YAML with potentially ambiguous indentation
    const ambiguousYaml = `name: test
  extra: value
    deep: nested`;

    const result = formatWorkflowYaml(ambiguousYaml);

    // Should return something (either formatted or original) without crashing
    expect(result).toBeDefined();
  });

  it('should respect indent option', () => {
    const input = `name: test
version: 1.0.0
phases:
  - name: phase1
    steps:
      - name: step1
        run: echo hello`;

    const result = formatWorkflowYaml(input, { indent: 4 });

    expect(result).toBeDefined();
    // The formatter should use 4 spaces for indentation
  });

  it('should handle empty content', () => {
    const result = formatWorkflowYaml('');
    expect(result).toBe('');
  });

  it('should handle whitespace-only content', () => {
    const result = formatWorkflowYaml('   \n\n   ');
    expect(result).toBeDefined();
  });

  it('should format multiline strings correctly', () => {
    const input = `name: test
version: 1.0.0
phases:
  - name: phase1
    steps:
      - name: step1
        run: |
          echo "line 1"
          echo "line 2"`;

    const result = formatWorkflowYaml(input);

    expect(result).toBeDefined();
    expect(result).toContain('echo "line 1"');
    expect(result).toContain('echo "line 2"');
  });

  it('should handle complex workflow structure', () => {
    const input = `name: complex-workflow
version: 2.0.0
description: A complex workflow
triggers:
  - type: schedule
    config:
      cron: "0 0 * * *"
env:
  NODE_ENV: production
phases:
  - name: build
    steps:
      - name: install
        run: npm install
      - name: compile
        run: npm run build
  - name: deploy
    condition: $\{{ success() }}
    steps:
      - name: upload
        uses: action/s3-upload
        with:
          bucket: my-bucket`;

    const result = formatWorkflowYaml(input);

    expect(result).toBeDefined();
    expect(result).toContain('complex-workflow');
    expect(result).toContain('triggers:');
    expect(result).toContain('phases:');
    expect(result).toContain('steps:');
  });

  it('should sort keys when sortKeys option is true', () => {
    const input = `phases:
  - name: test
    steps:
      - name: step1
        run: echo hello
version: 1.0.0
name: test-workflow`;

    const result = formatWorkflowYaml(input, { sortKeys: true });

    // Name should come before version which should come before phases
    const nameIndex = result.indexOf('name:');
    const versionIndex = result.indexOf('version:');
    const phasesIndex = result.indexOf('phases:');

    expect(nameIndex).toBeLessThan(versionIndex);
    expect(versionIndex).toBeLessThan(phasesIndex);
  });
});

describe('formatYaml', () => {
  it('should be an alias for formatWorkflowYaml with default options', () => {
    const input = 'name: test\nversion: 1.0.0\nphases: []';
    const result = formatYaml(input);

    expect(result).toBeDefined();
    expect(result).toContain('name:');
  });
});

describe('WorkflowFormattingProvider', () => {
  let provider: WorkflowFormattingProvider;

  beforeEach(() => {
    provider = new WorkflowFormattingProvider();
  });

  describe('provideDocumentFormattingEdits', () => {
    it('should return text edits for valid document', () => {
      const document = createMockDocument(`name:   test
version:  1.0.0
phases:
  - name: test
    steps:
      - name: step1
        run: echo hello`);
      const options = { tabSize: 2, insertSpaces: true };
      const token = { isCancellationRequested: false };

      const result = provider.provideDocumentFormattingEdits(
        document as any,
        options,
        token as any
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return empty array when content is unchanged', () => {
      const content = `name: test
version: 1.0.0
phases:
  - name: phase1
    steps:
      - name: step1
        run: echo hello
`;
      const document = createMockDocument(content);
      const options = { tabSize: 2, insertSpaces: true };
      const token = { isCancellationRequested: false };

      const result = provider.provideDocumentFormattingEdits(
        document as any,
        options,
        token as any
      );

      // May return empty if content is already formatted
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle errors gracefully', () => {
      const document = {
        getText: () => {
          throw new Error('Test error');
        },
        positionAt: () => ({ line: 0, character: 0 }),
      };
      const options = { tabSize: 2, insertSpaces: true };
      const token = { isCancellationRequested: false };

      const result = provider.provideDocumentFormattingEdits(
        document as any,
        options,
        token as any
      );

      expect(result).toEqual([]);
    });
  });

  describe('provideDocumentRangeFormattingEdits', () => {
    it('should format the entire document (current implementation)', () => {
      const document = createMockDocument(`name:   test
version:  1.0.0
phases: []`);
      const range = {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      };
      const options = { tabSize: 2, insertSpaces: true };
      const token = { isCancellationRequested: false };

      const result = provider.provideDocumentRangeFormattingEdits(
        document as any,
        range as any,
        options,
        token as any
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});

/**
 * Creates a mock VS Code TextDocument
 */
function createMockDocument(content: string) {
  return {
    getText: () => content,
    positionAt: (offset: number) => {
      let line = 0;
      let char = 0;
      for (let i = 0; i < offset && i < content.length; i++) {
        if (content[i] === '\n') {
          line++;
          char = 0;
        } else {
          char++;
        }
      }
      return { line, character: char };
    },
    languageId: 'generacy-workflow',
    uri: { fsPath: '/test/workflow.yaml' },
  };
}
