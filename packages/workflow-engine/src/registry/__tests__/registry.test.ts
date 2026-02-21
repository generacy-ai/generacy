import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerWorkflow,
  registerWorkflows,
  resolveRegisteredWorkflow,
  hasRegisteredWorkflow,
  getRegisteredWorkflowNames,
  clearWorkflowRegistry,
} from '../index.js';

/**
 * Create a temporary directory with workflow files for testing.
 * Returns the directory path and a cleanup function.
 */
function createTempWorkflows(files: string[]): { dir: string; cleanup: () => void } {
  const dir = resolve(tmpdir(), `workflow-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  for (const file of files) {
    writeFileSync(join(dir, file), `name: ${file}\nphases: []\n`);
  }

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('WorkflowRegistry', () => {
  let tempDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    clearWorkflowRegistry();
    const temp = createTempWorkflows(['workflow-a.yaml', 'workflow-b.yaml', 'workflow-c.yaml']);
    tempDir = temp.dir;
    cleanup = temp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('registerWorkflow()', () => {
    it('registers a workflow and resolves it correctly', () => {
      const filePath = join(tempDir, 'workflow-a.yaml');
      registerWorkflow('workflow-a', filePath);

      expect(resolveRegisteredWorkflow('workflow-a')).toBe(resolve(filePath));
    });

    it('throws on non-existent file path', () => {
      const badPath = join(tempDir, 'does-not-exist.yaml');

      expect(() => registerWorkflow('missing', badPath)).toThrow(
        /Cannot register workflow "missing": file not found/
      );
    });

    it('logs a warning on overwrite but succeeds', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const pathA = join(tempDir, 'workflow-a.yaml');
      const pathB = join(tempDir, 'workflow-b.yaml');

      registerWorkflow('my-workflow', pathA);
      registerWorkflow('my-workflow', pathB);

      expect(warnSpy).toHaveBeenCalledWith(
        'Overwriting existing workflow registration: my-workflow'
      );
      expect(resolveRegisteredWorkflow('my-workflow')).toBe(resolve(pathB));

      warnSpy.mockRestore();
    });

    it('stores the resolved absolute path', () => {
      // Register with a relative-like path that resolve() will normalize
      const filePath = join(tempDir, 'workflow-a.yaml');
      registerWorkflow('abs-test', filePath);

      const stored = resolveRegisteredWorkflow('abs-test');
      expect(stored).toBe(resolve(filePath));
    });
  });

  describe('registerWorkflows()', () => {
    it('batch registers from a Record', () => {
      const workflows: Record<string, string> = {
        'wf-a': join(tempDir, 'workflow-a.yaml'),
        'wf-b': join(tempDir, 'workflow-b.yaml'),
      };

      registerWorkflows(workflows);

      expect(resolveRegisteredWorkflow('wf-a')).toBe(resolve(workflows['wf-a']));
      expect(resolveRegisteredWorkflow('wf-b')).toBe(resolve(workflows['wf-b']));
    });

    it('batch registers from a Map', () => {
      const workflows = new Map<string, string>([
        ['wf-a', join(tempDir, 'workflow-a.yaml')],
        ['wf-c', join(tempDir, 'workflow-c.yaml')],
      ]);

      registerWorkflows(workflows);

      expect(resolveRegisteredWorkflow('wf-a')).toBeDefined();
      expect(resolveRegisteredWorkflow('wf-c')).toBeDefined();
    });

    it('throws if any file in the batch does not exist', () => {
      const workflows: Record<string, string> = {
        'wf-good': join(tempDir, 'workflow-a.yaml'),
        'wf-bad': join(tempDir, 'nonexistent.yaml'),
      };

      expect(() => registerWorkflows(workflows)).toThrow(
        /Cannot register workflow "wf-bad": file not found/
      );
    });
  });

  describe('resolveRegisteredWorkflow()', () => {
    it('returns undefined for an unregistered name', () => {
      expect(resolveRegisteredWorkflow('not-registered')).toBeUndefined();
    });

    it('returns the correct path for a registered workflow', () => {
      const filePath = join(tempDir, 'workflow-b.yaml');
      registerWorkflow('test-wf', filePath);

      expect(resolveRegisteredWorkflow('test-wf')).toBe(resolve(filePath));
    });
  });

  describe('hasRegisteredWorkflow()', () => {
    it('returns false for an unregistered name', () => {
      expect(hasRegisteredWorkflow('unknown')).toBe(false);
    });

    it('returns true for a registered name', () => {
      registerWorkflow('exists', join(tempDir, 'workflow-a.yaml'));
      expect(hasRegisteredWorkflow('exists')).toBe(true);
    });

    it('returns false after clearing the registry', () => {
      registerWorkflow('temp', join(tempDir, 'workflow-a.yaml'));
      clearWorkflowRegistry();
      expect(hasRegisteredWorkflow('temp')).toBe(false);
    });
  });

  describe('getRegisteredWorkflowNames()', () => {
    it('returns an empty array when no workflows are registered', () => {
      expect(getRegisteredWorkflowNames()).toEqual([]);
    });

    it('returns all registered names', () => {
      registerWorkflow('alpha', join(tempDir, 'workflow-a.yaml'));
      registerWorkflow('beta', join(tempDir, 'workflow-b.yaml'));
      registerWorkflow('gamma', join(tempDir, 'workflow-c.yaml'));

      const names = getRegisteredWorkflowNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
    });

    it('does not include duplicates after overwrite', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      registerWorkflow('dup', join(tempDir, 'workflow-a.yaml'));
      registerWorkflow('dup', join(tempDir, 'workflow-b.yaml'));

      const names = getRegisteredWorkflowNames();
      expect(names).toEqual(['dup']);

      vi.restoreAllMocks();
    });
  });

  describe('clearWorkflowRegistry()', () => {
    it('empties the registry completely', () => {
      registerWorkflow('a', join(tempDir, 'workflow-a.yaml'));
      registerWorkflow('b', join(tempDir, 'workflow-b.yaml'));

      expect(getRegisteredWorkflowNames()).toHaveLength(2);

      clearWorkflowRegistry();

      expect(getRegisteredWorkflowNames()).toHaveLength(0);
      expect(resolveRegisteredWorkflow('a')).toBeUndefined();
      expect(resolveRegisteredWorkflow('b')).toBeUndefined();
      expect(hasRegisteredWorkflow('a')).toBe(false);
    });

    it('allows re-registration after clearing', () => {
      registerWorkflow('reuse', join(tempDir, 'workflow-a.yaml'));
      clearWorkflowRegistry();
      registerWorkflow('reuse', join(tempDir, 'workflow-b.yaml'));

      expect(resolveRegisteredWorkflow('reuse')).toBe(resolve(join(tempDir, 'workflow-b.yaml')));
    });
  });
});
