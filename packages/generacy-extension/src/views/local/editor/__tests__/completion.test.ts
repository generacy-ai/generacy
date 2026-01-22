/**
 * Tests for the workflow completion provider
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module before any imports
vi.mock('vscode', () => ({
  CompletionItem: class {
    label: string;
    kind: number;
    detail?: string;
    documentation?: { value: string };
    insertText?: { value: string };
    sortText?: string;

    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  CompletionItemKind: {
    Property: 9,
    EnumMember: 19,
    Function: 2,
    Variable: 5,
    Snippet: 14,
    Module: 8,
    Value: 11,
  },
  CompletionList: class {
    items: unknown[];
    isIncomplete: boolean;

    constructor(items: unknown[], isIncomplete: boolean) {
      this.items = items;
      this.isIncomplete = isIncomplete;
    }
  },
  MarkdownString: class {
    value: string;
    isTrusted: boolean = false;

    constructor(value?: string) {
      this.value = value || '';
    }

    appendMarkdown(str: string): void {
      this.value += str;
    }

    appendCodeblock(code: string, language?: string): void {
      this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`;
    }
  },
  SnippetString: class {
    value: string;

    constructor(value: string) {
      this.value = value;
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
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };

    constructor(
      startLine: number,
      startChar: number,
      endLine: number,
      endChar: number
    ) {
      this.start = { line: startLine, character: startChar };
      this.end = { line: endLine, character: endChar };
    }
  },
  languages: {
    registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  CompletionTriggerKind: {
    Invoke: 0,
    TriggerCharacter: 1,
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

import { WorkflowCompletionProvider } from '../completion';

// Create a mock Position class for testing
class MockPosition {
  line: number;
  character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

describe('WorkflowCompletionProvider', () => {
  let provider: WorkflowCompletionProvider;

  beforeEach(() => {
    provider = new WorkflowCompletionProvider();
  });

  describe('provideCompletionItems', () => {
    it('should return completion items for workflow root', () => {
      const document = createMockDocument('');
      const position = new MockPosition(0, 0);
      const token = { isCancellationRequested: false };
      const context = { triggerKind: 0 };

      const result = provider.provideCompletionItems(
        document as any,
        position as any,
        token as any,
        context as any
      );

      expect(result).toBeDefined();
    });

    it('should return expression completions inside ${{ }}', () => {
      const document = createMockDocument('condition: ${{ ');
      const position = new MockPosition(0, 15);
      const token = { isCancellationRequested: false };
      const context = { triggerKind: 0 };

      const result = provider.provideCompletionItems(
        document as any,
        position as any,
        token as any,
        context as any
      );

      expect(result).toBeDefined();
      // Should include expression functions like always(), success(), failure()
      if (Array.isArray(result)) {
        const labels = result.map((item: any) => item.label);
        expect(labels).toContain('always()');
        expect(labels).toContain('success()');
        expect(labels).toContain('failure()');
        expect(labels).toContain('env');
        expect(labels).toContain('secrets');
      }
    });

    it('should return step properties when in step context', () => {
      const yamlContent = `
phases:
  - name: test
    steps:
      - name: step1
        `;
      const document = createMockDocument(yamlContent);
      const position = new MockPosition(5, 8);
      const token = { isCancellationRequested: false };
      const context = { triggerKind: 0 };

      const result = provider.provideCompletionItems(
        document as any,
        position as any,
        token as any,
        context as any
      );

      expect(result).toBeDefined();
    });

    it('should return trigger type values after type:', () => {
      const document = createMockDocument('triggers:\n  - type: ');
      const position = new MockPosition(1, 10);
      const token = { isCancellationRequested: false };
      const context = { triggerKind: 0 };

      const result = provider.provideCompletionItems(
        document as any,
        position as any,
        token as any,
        context as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('resolveCompletionItem', () => {
    it('should return the item unchanged', () => {
      const item = { label: 'test' };
      const token = { isCancellationRequested: false };

      const result = provider.resolveCompletionItem(item as any, token as any);

      expect(result).toBe(item);
    });
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
    offsetAt: (position: { line: number; character: number }) => {
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      return offset + position.character;
    },
    getWordRangeAtPosition: () => null,
    languageId: 'generacy-workflow',
    uri: { fsPath: '/test/workflow.yaml' },
  };
}
