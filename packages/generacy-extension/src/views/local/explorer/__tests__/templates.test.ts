/**
 * Tests for templates.ts - TemplateManager
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';
import {
  TemplateManager,
  createTemplateQuickPickItems,
  type TemplateMetadata,
} from '../templates';

// Mock VS Code
vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: path.join(base.fsPath, ...parts),
      toString: () => path.join(base.fsPath, ...parts),
    })),
    file: vi.fn((p: string) => ({
      fsPath: p,
      toString: () => p,
    })),
  },
  workspace: {
    fs: {
      readFile: vi.fn(),
    },
    openTextDocument: vi.fn(),
  },
  window: {
    createQuickPick: vi.fn(),
    showTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  ViewColumn: {
    Beside: 2,
  },
}));

// Mock utils
vi.mock('../../../../utils', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('TemplateManager', () => {
  let manager: TemplateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TemplateManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('getTemplateMetadata', () => {
    it('should return metadata for all built-in templates', () => {
      const metadata = manager.getTemplateMetadata();

      expect(metadata).toHaveLength(3);
      expect(metadata.map((t) => t.id)).toContain('basic');
      expect(metadata.map((t) => t.id)).toContain('multi-phase');
      expect(metadata.map((t) => t.id)).toContain('with-triggers');
    });

    it('should include required metadata fields', () => {
      const metadata = manager.getTemplateMetadata();

      for (const template of metadata) {
        expect(template).toHaveProperty('id');
        expect(template).toHaveProperty('name');
        expect(template).toHaveProperty('description');
        expect(template).toHaveProperty('detail');
        expect(template).toHaveProperty('icon');
        expect(template).toHaveProperty('category');
      }
    });
  });

  describe('getTemplate', () => {
    it('should return undefined for unknown template ID', async () => {
      manager.initialize({
        extensionUri: { fsPath: '/test' },
      } as vscode.ExtensionContext);

      const template = await manager.getTemplate('unknown-template');

      expect(template).toBeUndefined();
    });

    it('should return undefined if not initialized', async () => {
      // getTemplate gracefully handles errors and returns undefined
      const template = await manager.getTemplate('basic');
      expect(template).toBeUndefined();
    });
  });

  describe('customizeTemplate', () => {
    it('should replace workflow name in template content', () => {
      const template = {
        id: 'basic',
        name: 'Basic',
        description: 'test',
        detail: 'test',
        icon: '$(file)',
        category: 'starter' as const,
        content: 'name: my-workflow\nversion: "1.0.0"',
      };

      const customized = manager.customizeTemplate(template, 'my-custom-workflow');

      expect(customized).toContain('name: my-custom-workflow');
      expect(customized).not.toContain('name: my-workflow');
    });
  });

  describe('clearCache', () => {
    it('should clear the template cache', () => {
      // Access private cache for testing
      const privateManager = manager as unknown as {
        templateCache: Map<string, unknown>;
      };
      privateManager.templateCache.set('test', {} as unknown);

      manager.clearCache();

      expect(privateManager.templateCache.size).toBe(0);
    });
  });
});

describe('createTemplateQuickPickItems', () => {
  it('should create quick pick items from template metadata', () => {
    const templates: TemplateMetadata[] = [
      {
        id: 'basic',
        name: 'Basic',
        description: 'A basic template',
        detail: 'For simple workflows',
        icon: '$(file)',
        category: 'starter',
      },
    ];

    const items = createTemplateQuickPickItems(templates);

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('$(file) Basic');
    expect(items[0]?.description).toBe('A basic template');
    expect(items[0]?.detail).toBe('For simple workflows');
    expect(items[0]?.template).toEqual(templates[0]);
  });
});

describe('Template Files Validation', () => {
  const templatesDir = path.resolve(
    __dirname,
    '../../../../../resources/templates'
  );

  // Only run these tests if the files exist (during integration testing)
  const templatesExist = fs.existsSync(templatesDir);

  describe.skipIf(!templatesExist)('template file validation', () => {
    const templateFiles = templatesExist
      ? fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'))
      : [];

    it.each(templateFiles)('%s should be valid YAML', (filename) => {
      const content = fs.readFileSync(
        path.join(templatesDir, filename),
        'utf-8'
      );

      expect(() => yaml.parse(content)).not.toThrow();
    });

    it.each(templateFiles)('%s should have required fields', (filename) => {
      const content = fs.readFileSync(
        path.join(templatesDir, filename),
        'utf-8'
      );
      const parsed = yaml.parse(content);

      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('phases');
      expect(Array.isArray(parsed.phases)).toBe(true);
      expect(parsed.phases.length).toBeGreaterThan(0);
    });

    it.each(templateFiles)(
      '%s should have placeholder name for customization',
      (filename) => {
        const content = fs.readFileSync(
          path.join(templatesDir, filename),
          'utf-8'
        );
        const parsed = yaml.parse(content);

        expect(parsed.name).toBe('my-workflow');
      }
    );

    it.each(templateFiles)(
      '%s phases should have required step fields',
      (filename) => {
        const content = fs.readFileSync(
          path.join(templatesDir, filename),
          'utf-8'
        );
        const parsed = yaml.parse(content);

        for (const phase of parsed.phases) {
          expect(phase).toHaveProperty('name');
          expect(phase).toHaveProperty('steps');
          expect(Array.isArray(phase.steps)).toBe(true);

          for (const step of phase.steps) {
            expect(step).toHaveProperty('name');
            // Each step should have either 'run' or 'uses'
            const hasRun = 'run' in step;
            const hasUses = 'uses' in step;
            expect(hasRun || hasUses).toBe(true);
          }
        }
      }
    );
  });
});
