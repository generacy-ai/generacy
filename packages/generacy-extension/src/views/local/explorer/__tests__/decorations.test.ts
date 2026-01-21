/**
 * Tests for decorations.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  WorkflowDecorationProvider,
  getWorkflowDecorationProvider,
  resetWorkflowDecorationProvider,
  WorkflowDecorationData,
} from '../decorations';

// Mock vscode module
vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
    parse: (str: string) => ({ fsPath: str.replace('file://', ''), toString: () => str }),
  },
  FileDecoration: class {
    badge?: string;
    tooltip?: string;
    color?: unknown;
    constructor(badge?: string, tooltip?: string, color?: unknown) {
      this.badge = badge;
      this.tooltip = tooltip;
      this.color = color;
    }
  },
  ThemeColor: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  EventEmitter: class<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    fire(data: T) {
      this.listeners.forEach((l) => l(data));
    }
    dispose() {
      this.listeners = [];
    }
  },
  CancellationToken: {
    None: { isCancellationRequested: false },
  },
}));

describe('WorkflowDecorationProvider', () => {
  let provider: WorkflowDecorationProvider;

  beforeEach(() => {
    resetWorkflowDecorationProvider();
    provider = new WorkflowDecorationProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('provideFileDecoration', () => {
    it('should return undefined for unknown URIs', () => {
      const uri = vscode.Uri.file('/test/unknown.yaml');
      const result = provider.provideFileDecoration(uri, vscode.CancellationToken.None);

      expect(result).toBeUndefined();
    });

    it('should return decoration for registered URIs', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      const result = provider.provideFileDecoration(uri, vscode.CancellationToken.None);

      expect(result).toBeInstanceOf(vscode.FileDecoration);
    });
  });

  describe('updateDecoration', () => {
    it('should add decoration for valid status', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      const decoration = provider.getDecoration(uri);
      expect(decoration).toBeDefined();
      expect(decoration?.badge).toBe('\u2713'); // Checkmark
      expect(decoration?.tooltip).toBe('Valid workflow');
    });

    it('should add decoration for invalid status', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'invalid', error: 'Parse error' });

      const decoration = provider.getDecoration(uri);
      expect(decoration).toBeDefined();
      expect(decoration?.badge).toBe('\u2717'); // X mark
      expect(decoration?.tooltip).toBe('Invalid: Parse error');
    });

    it('should add decoration for validating status', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'validating' });

      const decoration = provider.getDecoration(uri);
      expect(decoration).toBeDefined();
      expect(decoration?.badge).toBe('\u27F3'); // Refresh
      expect(decoration?.tooltip).toBe('Validating...');
    });

    it('should remove decoration for unknown status', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');

      // First add a decoration
      provider.updateDecoration({ uri, status: 'valid' });
      expect(provider.hasDecoration(uri)).toBe(true);

      // Then update to unknown (which removes decoration)
      provider.updateDecoration({ uri, status: 'unknown' });
      expect(provider.hasDecoration(uri)).toBe(false);
    });

    it('should fire change event when updating', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      const listener = vi.fn();

      provider.onDidChangeFileDecorations(listener);
      provider.updateDecoration({ uri, status: 'valid' });

      expect(listener).toHaveBeenCalledWith(uri);
    });
  });

  describe('updateDecorations', () => {
    it('should update multiple decorations at once', () => {
      const uri1 = vscode.Uri.file('/test/workflow1.yaml');
      const uri2 = vscode.Uri.file('/test/workflow2.yaml');

      provider.updateDecorations([
        { uri: uri1, status: 'valid' },
        { uri: uri2, status: 'invalid', error: 'Error' },
      ]);

      expect(provider.hasDecoration(uri1)).toBe(true);
      expect(provider.hasDecoration(uri2)).toBe(true);
    });

    it('should fire change event with all URIs', () => {
      const uri1 = vscode.Uri.file('/test/workflow1.yaml');
      const uri2 = vscode.Uri.file('/test/workflow2.yaml');
      const listener = vi.fn();

      provider.onDidChangeFileDecorations(listener);
      provider.updateDecorations([
        { uri: uri1, status: 'valid' },
        { uri: uri2, status: 'valid' },
      ]);

      expect(listener).toHaveBeenCalledWith([uri1, uri2]);
    });
  });

  describe('removeDecoration', () => {
    it('should remove existing decoration', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');

      provider.updateDecoration({ uri, status: 'valid' });
      expect(provider.hasDecoration(uri)).toBe(true);

      provider.removeDecoration(uri);
      expect(provider.hasDecoration(uri)).toBe(false);
    });

    it('should fire change event when removing', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      const listener = vi.fn();
      provider.onDidChangeFileDecorations(listener);
      provider.removeDecoration(uri);

      expect(listener).toHaveBeenCalledWith(uri);
    });

    it('should do nothing for non-existent decoration', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      const listener = vi.fn();

      provider.onDidChangeFileDecorations(listener);
      provider.removeDecoration(uri);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('clearDecorations', () => {
    it('should remove all decorations', () => {
      const uri1 = vscode.Uri.file('/test/workflow1.yaml');
      const uri2 = vscode.Uri.file('/test/workflow2.yaml');

      provider.updateDecorations([
        { uri: uri1, status: 'valid' },
        { uri: uri2, status: 'valid' },
      ]);

      provider.clearDecorations();

      expect(provider.hasDecoration(uri1)).toBe(false);
      expect(provider.hasDecoration(uri2)).toBe(false);
    });
  });

  describe('getDecoration', () => {
    it('should return decoration for existing URI', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      const decoration = provider.getDecoration(uri);
      expect(decoration).toBeDefined();
    });

    it('should return undefined for non-existent URI', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      const decoration = provider.getDecoration(uri);

      expect(decoration).toBeUndefined();
    });
  });

  describe('hasDecoration', () => {
    it('should return true for decorated URI', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      expect(provider.hasDecoration(uri)).toBe(true);
    });

    it('should return false for non-decorated URI', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      expect(provider.hasDecoration(uri)).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should clear all decorations on dispose', () => {
      const uri = vscode.Uri.file('/test/workflow.yaml');
      provider.updateDecoration({ uri, status: 'valid' });

      provider.dispose();

      expect(provider.hasDecoration(uri)).toBe(false);
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    resetWorkflowDecorationProvider();
  });

  afterEach(() => {
    resetWorkflowDecorationProvider();
  });

  it('getWorkflowDecorationProvider should return singleton', () => {
    const provider1 = getWorkflowDecorationProvider();
    const provider2 = getWorkflowDecorationProvider();

    expect(provider1).toBe(provider2);
  });

  it('resetWorkflowDecorationProvider should create new instance', () => {
    const provider1 = getWorkflowDecorationProvider();
    resetWorkflowDecorationProvider();
    const provider2 = getWorkflowDecorationProvider();

    expect(provider1).not.toBe(provider2);
  });
});
