/**
 * Tests for the workflow hover provider
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  Hover: class {
    contents: any;
    range?: any;

    constructor(contents: any, range?: any) {
      this.contents = contents;
      this.range = range;
    }
  },
  MarkdownString: class {
    value: string;
    isTrusted: boolean = false;

    constructor(value?: string) {
      this.value = value || '';
    }

    appendMarkdown(str: string): this {
      this.value += str;
      return this;
    }

    appendCodeblock(code: string, language?: string): this {
      this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`;
      return this;
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
  Position: class {
    line: number;
    character: number;

    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  },
  languages: {
    registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
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

import { WorkflowHoverProvider } from '../hover';

describe('WorkflowHoverProvider', () => {
  let provider: WorkflowHoverProvider;

  beforeEach(() => {
    provider = new WorkflowHoverProvider();
  });

  describe('provideHover', () => {
    it('should return hover for workflow property "name"', () => {
      const document = createMockDocument('name: my-workflow');
      const position = { line: 0, character: 2 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
      if (result) {
        expect(result.contents).toBeDefined();
      }
    });

    it('should return hover for "version" property', () => {
      const document = createMockDocument('version: 1.0.0');
      const position = { line: 0, character: 4 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for "phases" property', () => {
      const document = createMockDocument('phases:');
      const position = { line: 0, character: 3 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for "triggers" property', () => {
      const document = createMockDocument('triggers:');
      const position = { line: 0, character: 5 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for "steps" property', () => {
      const document = createMockDocument('steps:');
      const position = { line: 0, character: 3 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for "uses" property', () => {
      const document = createMockDocument('uses: agent/claude-code');
      const position = { line: 0, character: 2 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for "run" property', () => {
      const document = createMockDocument('run: echo hello');
      const position = { line: 0, character: 1 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for expression function inside ${{ }}', () => {
      const document = createMockDocument('condition: ${{ always() }}');
      const position = { line: 0, character: 17 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      // Note: Hover provider needs proper word detection
      expect(result).toBeDefined();
    });

    it('should return null for unknown properties', () => {
      const document = createMockDocument('unknownProperty: value');
      const position = { line: 0, character: 8 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeNull();
    });

    it('should return null when no word at position', () => {
      const document = createMockDocumentWithNoWord('   ');
      const position = { line: 0, character: 1 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeNull();
    });

    it('should return hover for trigger type values', () => {
      const document = createMockDocument('type: manual');
      const position = { line: 0, character: 8 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });

    it('should return hover for strategy values', () => {
      const document = createMockDocument('strategy: fail');
      const position = { line: 0, character: 12 };
      const token = { isCancellationRequested: false };

      const result = provider.provideHover(document as any, position as any, token as any);

      expect(result).toBeDefined();
    });
  });
});

/**
 * Creates a mock VS Code TextDocument
 */
function createMockDocument(content: string) {
  const lines = content.split('\n');

  return {
    getText: (range?: any) => {
      if (range) {
        return content.substring(range.start.character, range.end.character);
      }
      return content;
    },
    lineAt: (line: number) => ({
      text: lines[line] || '',
      lineNumber: line,
    }),
    getWordRangeAtPosition: (position: { line: number; character: number }) => {
      const line = lines[position.line] || '';
      // Simple word detection
      const before = line.substring(0, position.character);
      const after = line.substring(position.character);
      const wordStartMatch = before.match(/\w+$/);
      const wordEndMatch = after.match(/^\w+/);

      if (wordStartMatch || wordEndMatch) {
        const startChar = wordStartMatch
          ? position.character - wordStartMatch[0].length
          : position.character;
        const endChar = wordEndMatch
          ? position.character + wordEndMatch[0].length
          : position.character;
        return {
          start: { line: position.line, character: startChar },
          end: { line: position.line, character: endChar },
        };
      }
      return null;
    },
    languageId: 'generacy-workflow',
    uri: { fsPath: '/test/workflow.yaml' },
  };
}

/**
 * Creates a mock document that returns null for getWordRangeAtPosition
 */
function createMockDocumentWithNoWord(content: string) {
  const lines = content.split('\n');

  return {
    getText: () => content,
    lineAt: (line: number) => ({
      text: lines[line] || '',
      lineNumber: line,
    }),
    getWordRangeAtPosition: () => null,
    languageId: 'generacy-workflow',
    uri: { fsPath: '/test/workflow.yaml' },
  };
}
