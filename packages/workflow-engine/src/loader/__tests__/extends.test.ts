import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeWorkflows } from '../extends.js';
import { loadWorkflow, loadWorkflowWithExtends } from '../index.js';
import { WorkflowOverrideError } from '../../errors/workflow-override.js';
import { CircularExtendsError } from '../../errors/circular-extends.js';
import { BaseWorkflowNotFoundError } from '../../errors/base-workflow-not-found.js';
import type { WorkflowDefinition } from '../../types/workflow.js';
import type { WorkflowOverrideData } from '../extends.js';
import type { WorkflowResolver } from '../index.js';

/**
 * Creates a minimal valid base workflow for testing.
 */
function createBaseWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'base-workflow',
    description: 'Base workflow description',
    version: '1.0.0',
    phases: [
      {
        name: 'setup',
        steps: [
          { name: 'prepare', action: 'shell', command: 'echo setup' },
        ],
      },
      {
        name: 'build',
        steps: [
          { name: 'compile', action: 'shell', command: 'npm run build' },
        ],
      },
      {
        name: 'test',
        steps: [
          { name: 'run-tests', action: 'shell', command: 'npm test' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('mergeWorkflows', () => {
  describe('scalar overrides', () => {
    it('overrides name from override data', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = { name: 'custom-workflow' };

      const result = mergeWorkflows(base, overrideData);

      expect(result.name).toBe('custom-workflow');
    });

    it('overrides description from override data', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = { description: 'Custom description' };

      const result = mergeWorkflows(base, overrideData);

      expect(result.description).toBe('Custom description');
    });

    it('overrides version from override data', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = { version: '2.0.0' };

      const result = mergeWorkflows(base, overrideData);

      expect(result.version).toBe('2.0.0');
    });

    it('overrides multiple scalars at once', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        name: 'custom',
        description: 'Custom desc',
        version: '3.0.0',
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.name).toBe('custom');
      expect(result.description).toBe('Custom desc');
      expect(result.version).toBe('3.0.0');
    });

    it('preserves base scalars when override does not provide them', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {};

      const result = mergeWorkflows(base, overrideData);

      expect(result.name).toBe('base-workflow');
      expect(result.description).toBe('Base workflow description');
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('timeout and retry overrides', () => {
    it('overrides timeout from override data', () => {
      const base = createBaseWorkflow({ timeout: 60000 });
      const overrideData: WorkflowOverrideData = { timeout: 120000 };

      const result = mergeWorkflows(base, overrideData);

      expect(result.timeout).toBe(120000);
    });

    it('preserves base timeout when override does not provide it', () => {
      const base = createBaseWorkflow({ timeout: 60000 });
      const overrideData: WorkflowOverrideData = { name: 'renamed' };

      const result = mergeWorkflows(base, overrideData);

      expect(result.timeout).toBe(60000);
    });

    it('overrides retry from override data', () => {
      const base = createBaseWorkflow({
        retry: { maxAttempts: 2, delay: 1000, backoff: 'constant' },
      });
      const overrideData: WorkflowOverrideData = {
        retry: { maxAttempts: 5, delay: 2000, backoff: 'exponential', maxDelay: 30000 },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.retry).toEqual({
        maxAttempts: 5,
        delay: 2000,
        backoff: 'exponential',
        maxDelay: 30000,
      });
    });

    it('preserves base retry when override does not provide it', () => {
      const base = createBaseWorkflow({
        retry: { maxAttempts: 3, delay: 500, backoff: 'linear' },
      });
      const overrideData: WorkflowOverrideData = {};

      const result = mergeWorkflows(base, overrideData);

      expect(result.retry).toEqual({ maxAttempts: 3, delay: 500, backoff: 'linear' });
    });
  });

  describe('phase overrides', () => {
    it('replaces steps in an existing phase entirely', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              steps: [
                { name: 'custom-build', action: 'shell', command: 'make build' },
                { name: 'post-build', action: 'shell', command: 'make lint' },
              ],
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      const buildPhase = result.phases.find(p => p.name === 'build');
      expect(buildPhase).toBeDefined();
      expect(buildPhase!.steps).toHaveLength(2);
      expect(buildPhase!.steps[0]!.name).toBe('custom-build');
      expect(buildPhase!.steps[1]!.name).toBe('post-build');
    });

    it('overrides condition on an existing phase', () => {
      const base = createBaseWorkflow();
      base.phases[1]!.condition = 'always()';

      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              condition: 'env.CI === "true"',
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      const buildPhase = result.phases.find(p => p.name === 'build');
      expect(buildPhase!.condition).toBe('env.CI === "true"');
    });

    it('replaces steps and overrides condition simultaneously', () => {
      const base = createBaseWorkflow();

      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              steps: [{ name: 'new-step', action: 'shell', command: 'echo new' }],
              condition: 'inputs.skip_build !== "true"',
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      const buildPhase = result.phases.find(p => p.name === 'build');
      expect(buildPhase!.steps).toHaveLength(1);
      expect(buildPhase!.steps[0]!.name).toBe('new-step');
      expect(buildPhase!.condition).toBe('inputs.skip_build !== "true"');
    });

    it('preserves base phases not mentioned in overrides', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              steps: [{ name: 'custom', action: 'shell', command: 'echo custom' }],
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      // setup and test phases should be untouched
      expect(result.phases).toHaveLength(3);
      const setupPhase = result.phases.find(p => p.name === 'setup');
      expect(setupPhase!.steps[0]!.name).toBe('prepare');
      const testPhase = result.phases.find(p => p.name === 'test');
      expect(testPhase!.steps[0]!.name).toBe('run-tests');
    });
  });

  describe('phase insertion with positional directives', () => {
    it('inserts a new phase after a named phase using after:', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            lint: {
              after: 'build',
              steps: [{ name: 'run-lint', action: 'shell', command: 'npm run lint' }],
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.phases).toHaveLength(4);
      const names = result.phases.map(p => p.name);
      expect(names).toEqual(['setup', 'build', 'lint', 'test']);
    });

    it('inserts a new phase before a named phase using before:', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            'pre-build': {
              before: 'build',
              steps: [{ name: 'check-deps', action: 'shell', command: 'npm audit' }],
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.phases).toHaveLength(4);
      const names = result.phases.map(p => p.name);
      expect(names).toEqual(['setup', 'pre-build', 'build', 'test']);
    });

    it('sets condition on a newly inserted phase', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            deploy: {
              after: 'test',
              steps: [{ name: 'deploy-staging', action: 'shell', command: 'npm run deploy' }],
              condition: 'env.DEPLOY === "true"',
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      const deployPhase = result.phases.find(p => p.name === 'deploy');
      expect(deployPhase).toBeDefined();
      expect(deployPhase!.condition).toBe('env.DEPLOY === "true"');
    });

    it('throws WorkflowOverrideError when anchor phase does not exist', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            deploy: {
              after: 'nonexistent-phase',
              steps: [{ name: 'deploy', action: 'shell', command: 'deploy' }],
            },
          },
        },
      };

      expect(() => mergeWorkflows(base, overrideData)).toThrow(WorkflowOverrideError);
      expect(() => mergeWorkflows(base, overrideData)).toThrow(
        /references anchor phase "nonexistent-phase" which does not exist/,
      );
    });

    it('throws WorkflowOverrideError when new phase has no steps', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            empty: {
              after: 'build',
              steps: [],
            },
          },
        },
      };

      expect(() => mergeWorkflows(base, overrideData)).toThrow(WorkflowOverrideError);
      expect(() => mergeWorkflows(base, overrideData)).toThrow(
        /requires at least one step/,
      );
    });
  });

  describe('unknown phase without positional directive', () => {
    it('throws WorkflowOverrideError for an unknown phase name', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            'bild': { // typo of 'build'
              steps: [{ name: 'typo-step', action: 'shell', command: 'echo typo' }],
            },
          },
        },
      };

      expect(() => mergeWorkflows(base, overrideData)).toThrow(WorkflowOverrideError);
      expect(() => mergeWorkflows(base, overrideData)).toThrow(
        /Phase "bild" does not exist in the base workflow and has no "before" or "after" directive/,
      );
    });

    it('includes base phase names in the error message for typo help', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            'unknown-phase': {
              steps: [{ name: 's', action: 'shell', command: 'echo' }],
            },
          },
        },
      };

      expect(() => mergeWorkflows(base, overrideData)).toThrow(
        /Did you mean one of: setup, build, test/,
      );
    });
  });

  describe('input merging', () => {
    it('preserves base inputs and adds override inputs', () => {
      const base = createBaseWorkflow({
        inputs: [
          { name: 'repo', description: 'Repository URL', required: true },
          { name: 'branch', description: 'Branch name', default: 'main' },
        ],
      });
      const overrideData: WorkflowOverrideData = {
        overrides: {
          inputs: [
            { name: 'environment', description: 'Deploy environment', required: true },
          ],
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.inputs).toHaveLength(3);
      expect(result.inputs!.map(i => i.name)).toEqual(['repo', 'branch', 'environment']);
    });

    it('override input wins on name collision', () => {
      const base = createBaseWorkflow({
        inputs: [
          { name: 'timeout', description: 'Base timeout', type: 'number', default: 60 },
          { name: 'branch', description: 'Branch name', default: 'main' },
        ],
      });
      const overrideData: WorkflowOverrideData = {
        overrides: {
          inputs: [
            { name: 'timeout', description: 'Custom timeout', type: 'number', default: 120 },
          ],
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.inputs).toHaveLength(2);
      const timeoutInput = result.inputs!.find(i => i.name === 'timeout');
      expect(timeoutInput!.description).toBe('Custom timeout');
      expect(timeoutInput!.default).toBe(120);
      // branch should still be present
      expect(result.inputs!.find(i => i.name === 'branch')).toBeDefined();
    });

    it('handles base with no inputs', () => {
      const base = createBaseWorkflow(); // no inputs
      const overrideData: WorkflowOverrideData = {
        overrides: {
          inputs: [
            { name: 'new-input', description: 'Brand new', required: true },
          ],
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.inputs).toHaveLength(1);
      expect(result.inputs![0]!.name).toBe('new-input');
    });
  });

  describe('env merging', () => {
    it('shallow merges env, override wins on key collision', () => {
      const base = createBaseWorkflow({
        env: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
          API_URL: 'https://api.example.com',
        },
      });
      const overrideData: WorkflowOverrideData = {
        overrides: {
          env: {
            LOG_LEVEL: 'debug',
            EXTRA_VAR: 'custom-value',
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.env).toEqual({
        NODE_ENV: 'production',
        LOG_LEVEL: 'debug',
        API_URL: 'https://api.example.com',
        EXTRA_VAR: 'custom-value',
      });
    });

    it('preserves base env when override has no env', () => {
      const base = createBaseWorkflow({
        env: { KEY: 'value' },
      });
      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              steps: [{ name: 's', action: 'shell', command: 'echo' }],
            },
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.env).toEqual({ KEY: 'value' });
    });

    it('handles base with no env', () => {
      const base = createBaseWorkflow(); // no env
      const overrideData: WorkflowOverrideData = {
        overrides: {
          env: { NEW_KEY: 'new-value' },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.env).toEqual({ NEW_KEY: 'new-value' });
    });
  });

  describe('mutual exclusivity: phases + overrides.phases', () => {
    it('throws WorkflowOverrideError when both phases and overrides.phases are present', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        phases: [
          { name: 'new-phase', steps: [{ name: 's', action: 'shell', command: 'echo' }] },
        ],
        overrides: {
          phases: {
            build: {
              steps: [{ name: 's', action: 'shell', command: 'echo' }],
            },
          },
        },
      };

      expect(() => mergeWorkflows(base, overrideData)).toThrow(WorkflowOverrideError);
      expect(() => mergeWorkflows(base, overrideData)).toThrow(
        /Cannot specify both "phases" and "overrides.phases"/,
      );
    });
  });

  describe('full replacement mode with phases', () => {
    it('replaces all base phases when overrideData.phases is provided', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {
        phases: [
          {
            name: 'only-phase',
            steps: [{ name: 'single-step', action: 'shell', command: 'echo replaced' }],
          },
        ],
      };

      const result = mergeWorkflows(base, overrideData);

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.name).toBe('only-phase');
      expect(result.phases[0]!.steps[0]!.name).toBe('single-step');
    });
  });

  describe('immutability', () => {
    it('does not mutate the base workflow', () => {
      const base = createBaseWorkflow();
      const originalName = base.name;
      const originalPhaseCount = base.phases.length;
      const originalFirstStepName = base.phases[0]!.steps[0]!.name;

      const overrideData: WorkflowOverrideData = {
        name: 'modified',
        overrides: {
          phases: {
            setup: {
              steps: [{ name: 'replaced', action: 'shell', command: 'echo replaced' }],
            },
            deploy: {
              after: 'test',
              steps: [{ name: 'deploy', action: 'shell', command: 'deploy' }],
            },
          },
        },
      };

      mergeWorkflows(base, overrideData);

      expect(base.name).toBe(originalName);
      expect(base.phases).toHaveLength(originalPhaseCount);
      expect(base.phases[0]!.steps[0]!.name).toBe(originalFirstStepName);
    });

    it('does not mutate the base phases steps array', () => {
      const base = createBaseWorkflow();
      const originalSteps = [...base.phases[1]!.steps];

      const overrideData: WorkflowOverrideData = {
        overrides: {
          phases: {
            build: {
              steps: [{ name: 'new', action: 'shell', command: 'new' }],
            },
          },
        },
      };

      mergeWorkflows(base, overrideData);

      expect(base.phases[1]!.steps).toEqual(originalSteps);
    });
  });

  describe('complex scenarios', () => {
    it('combines scalar overrides, phase overrides, input merging, and env merging', () => {
      const base = createBaseWorkflow({
        timeout: 30000,
        inputs: [
          { name: 'repo', required: true },
        ],
        env: { NODE_ENV: 'production' },
      });

      const overrideData: WorkflowOverrideData = {
        name: 'full-override-workflow',
        timeout: 120000,
        overrides: {
          phases: {
            build: {
              steps: [{ name: 'custom-build', action: 'shell', command: 'make all' }],
              condition: 'inputs.skip !== "true"',
            },
            lint: {
              after: 'build',
              steps: [{ name: 'lint', action: 'shell', command: 'eslint .' }],
            },
          },
          inputs: [
            { name: 'skip', type: 'boolean', default: false },
          ],
          env: {
            NODE_ENV: 'development',
            DEBUG: 'true',
          },
        },
      };

      const result = mergeWorkflows(base, overrideData);

      // Scalar overrides
      expect(result.name).toBe('full-override-workflow');
      expect(result.timeout).toBe(120000);

      // Phase overrides + insertion
      expect(result.phases).toHaveLength(4);
      const names = result.phases.map(p => p.name);
      expect(names).toEqual(['setup', 'build', 'lint', 'test']);
      expect(result.phases[1]!.steps[0]!.name).toBe('custom-build');
      expect(result.phases[1]!.condition).toBe('inputs.skip !== "true"');

      // Input merging
      expect(result.inputs).toHaveLength(2);
      expect(result.inputs!.map(i => i.name)).toEqual(['repo', 'skip']);

      // Env merging
      expect(result.env).toEqual({
        NODE_ENV: 'development',
        DEBUG: 'true',
      });
    });

    it('handles empty override data (no-op merge)', () => {
      const base = createBaseWorkflow();
      const overrideData: WorkflowOverrideData = {};

      const result = mergeWorkflows(base, overrideData);

      expect(result.name).toBe(base.name);
      expect(result.phases).toHaveLength(base.phases.length);
      expect(result.phases.map(p => p.name)).toEqual(base.phases.map(p => p.name));
    });
  });
});

// --- loadWorkflowWithExtends() tests ---

/**
 * Minimal valid workflow YAML content.
 */
const BASE_WORKFLOW_YAML = `
name: base-workflow
description: A base workflow
version: "1.0.0"
phases:
  - name: setup
    steps:
      - name: prepare
        action: shell
        command: echo setup
  - name: build
    steps:
      - name: compile
        action: shell
        command: npm run build
  - name: test
    steps:
      - name: run-tests
        action: shell
        command: npm test
`.trimStart();

/**
 * Creates a temp directory with YAML files and returns a resolver + cleanup function.
 */
function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = resolve(tmpdir(), `wf-extends-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Writes a YAML file to the temp directory and returns its absolute path.
 */
function writeYaml(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Creates a simple resolver that maps workflow names to file paths.
 */
function createResolver(mapping: Record<string, string>): WorkflowResolver {
  return (name: string, excludePath?: string) => {
    const resolved = mapping[name];
    if (!resolved || resolve(resolved) === excludePath) {
      throw new BaseWorkflowNotFoundError(name, Object.values(mapping));
    }
    return resolved;
  };
}

describe('loadWorkflowWithExtends', () => {
  let tempDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const temp = createTempDir();
    tempDir = temp.dir;
    cleanup = temp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('non-extends workflows', () => {
    it('loads identically to loadWorkflow() for a workflow without extends', async () => {
      const filePath = writeYaml(tempDir, 'simple.yaml', BASE_WORKFLOW_YAML);
      const resolver = createResolver({});

      const result = await loadWorkflowWithExtends(filePath, resolver);
      const direct = await loadWorkflow(filePath);

      expect(result).toEqual(direct);
    });

    it('validates the workflow against the strict schema', async () => {
      const invalidYaml = `
name: invalid
phases: []
`.trimStart();
      const filePath = writeYaml(tempDir, 'invalid.yaml', invalidYaml);
      const resolver = createResolver({});

      await expect(loadWorkflowWithExtends(filePath, resolver)).rejects.toThrow(
        /validation failed/i,
      );
    });
  });

  describe('single-level extends', () => {
    it('resolves base workflow, merges, and validates', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: child-workflow
description: Overridden description
overrides:
  phases:
    build:
      steps:
        - name: custom-build
          action: shell
          command: make all
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });
      const result = await loadWorkflowWithExtends(childPath, resolver);

      expect(result.name).toBe('child-workflow');
      expect(result.description).toBe('Overridden description');
      // Base phases preserved
      expect(result.phases).toHaveLength(3);
      expect(result.phases.map(p => p.name)).toEqual(['setup', 'build', 'test']);
      // Build phase overridden
      const buildPhase = result.phases.find(p => p.name === 'build');
      expect(buildPhase!.steps).toHaveLength(1);
      expect(buildPhase!.steps[0]!.name).toBe('custom-build');
      // Setup and test untouched
      expect(result.phases.find(p => p.name === 'setup')!.steps[0]!.name).toBe('prepare');
      expect(result.phases.find(p => p.name === 'test')!.steps[0]!.name).toBe('run-tests');
    });

    it('preserves base version when child does not override it', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: child-no-version
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });
      const result = await loadWorkflowWithExtends(childPath, resolver);

      expect(result.version).toBe('1.0.0');
    });
  });

  describe('multi-level extends', () => {
    it('correctly merges A extends B extends C (C -> B -> A order)', async () => {
      // C is the root base
      const cYaml = `
name: workflow-c
description: Root base
version: "1.0.0"
phases:
  - name: init
    steps:
      - name: init-step
        action: shell
        command: echo init
  - name: build
    steps:
      - name: build-step
        action: shell
        command: echo build
  - name: verify
    steps:
      - name: verify-step
        action: shell
        command: echo verify
`.trimStart();
      const cPath = writeYaml(tempDir, 'c.yaml', cYaml);

      // B extends C, overrides build phase
      const bYaml = `
extends: workflow-c
name: workflow-b
overrides:
  phases:
    build:
      steps:
        - name: build-b
          action: shell
          command: echo build-from-b
`.trimStart();
      const bPath = writeYaml(tempDir, 'b.yaml', bYaml);

      // A extends B, adds a phase and overrides name
      const aYaml = `
extends: workflow-b
name: workflow-a
description: Final workflow
overrides:
  phases:
    verify:
      steps:
        - name: verify-a
          action: shell
          command: echo verify-from-a
    deploy:
      after: verify
      steps:
        - name: deploy-step
          action: shell
          command: echo deploy
`.trimStart();
      const aPath = writeYaml(tempDir, 'a.yaml', aYaml);

      const resolver = createResolver({
        'workflow-c': cPath,
        'workflow-b': bPath,
      });

      const result = await loadWorkflowWithExtends(aPath, resolver);

      // Name from A (top-most)
      expect(result.name).toBe('workflow-a');
      expect(result.description).toBe('Final workflow');

      // Phases: init (from C), build (from B's override), verify (from A's override), deploy (inserted by A)
      expect(result.phases.map(p => p.name)).toEqual(['init', 'build', 'verify', 'deploy']);
      expect(result.phases.find(p => p.name === 'init')!.steps[0]!.name).toBe('init-step');
      expect(result.phases.find(p => p.name === 'build')!.steps[0]!.name).toBe('build-b');
      expect(result.phases.find(p => p.name === 'verify')!.steps[0]!.name).toBe('verify-a');
      expect(result.phases.find(p => p.name === 'deploy')!.steps[0]!.name).toBe('deploy-step');
    });
  });

  describe('circular extends detection', () => {
    it('detects A extends B extends A and throws CircularExtendsError', async () => {
      const aYaml = `
extends: workflow-b
name: workflow-a
phases:
  - name: phase-a
    steps:
      - name: step-a
        action: shell
        command: echo a
`.trimStart();
      const aPath = writeYaml(tempDir, 'a.yaml', aYaml);

      const bYaml = `
extends: workflow-a
name: workflow-b
phases:
  - name: phase-b
    steps:
      - name: step-b
        action: shell
        command: echo b
`.trimStart();
      const bPath = writeYaml(tempDir, 'b.yaml', bYaml);

      const resolver = createResolver({
        'workflow-a': aPath,
        'workflow-b': bPath,
      });

      await expect(loadWorkflowWithExtends(aPath, resolver)).rejects.toThrow(CircularExtendsError);
    });

    it('includes the full chain in the CircularExtendsError', async () => {
      const aYaml = `
extends: workflow-b
name: workflow-a
phases:
  - name: p
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const aPath = writeYaml(tempDir, 'a.yaml', aYaml);

      const bYaml = `
extends: workflow-a
name: workflow-b
phases:
  - name: p
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const bPath = writeYaml(tempDir, 'b.yaml', bYaml);

      const resolver = createResolver({
        'workflow-a': aPath,
        'workflow-b': bPath,
      });

      try {
        await loadWorkflowWithExtends(aPath, resolver);
        expect.fail('Should have thrown CircularExtendsError');
      } catch (error) {
        expect(error).toBeInstanceOf(CircularExtendsError);
        const chain = (error as CircularExtendsError).chain;
        expect(chain).toContain(resolve(aPath));
        expect(chain).toContain(resolve(bPath));
      }
    });

    it('detects self-extends via excludePath and throws BaseWorkflowNotFoundError', async () => {
      // When a workflow extends itself, the resolver's excludePath mechanism
      // prevents self-resolution (the current file is excluded from resolution).
      // This results in BaseWorkflowNotFoundError rather than CircularExtendsError.
      const selfYaml = `
extends: self-workflow
name: self-workflow
phases:
  - name: p
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const selfPath = writeYaml(tempDir, 'self.yaml', selfYaml);

      const resolver = createResolver({
        'self-workflow': selfPath,
      });

      await expect(loadWorkflowWithExtends(selfPath, resolver)).rejects.toThrow(
        BaseWorkflowNotFoundError,
      );
    });
  });

  describe('base workflow not found', () => {
    it('throws BaseWorkflowNotFoundError when base cannot be resolved', async () => {
      const childYaml = `
extends: nonexistent-base
name: child
phases:
  - name: p
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({});

      await expect(loadWorkflowWithExtends(childPath, resolver)).rejects.toThrow(
        BaseWorkflowNotFoundError,
      );
    });

    it('includes the workflow name in the error', async () => {
      const childYaml = `
extends: missing-workflow
name: child
phases:
  - name: p
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({});

      try {
        await loadWorkflowWithExtends(childPath, resolver);
        expect.fail('Should have thrown BaseWorkflowNotFoundError');
      } catch (error) {
        expect(error).toBeInstanceOf(BaseWorkflowNotFoundError);
        expect((error as BaseWorkflowNotFoundError).workflowName).toBe('missing-workflow');
      }
    });
  });

  describe('overrides without extends', () => {
    it('throws WorkflowOverrideError when overrides is present without extends', async () => {
      const yaml = `
name: bad-workflow
overrides:
  phases:
    build:
      steps:
        - name: s
          action: shell
          command: echo
phases:
  - name: build
    steps:
      - name: s
        action: shell
        command: echo
`.trimStart();
      const filePath = writeYaml(tempDir, 'bad.yaml', yaml);
      const resolver = createResolver({});

      await expect(loadWorkflowWithExtends(filePath, resolver)).rejects.toThrow(
        WorkflowOverrideError,
      );
      await expect(loadWorkflowWithExtends(filePath, resolver)).rejects.toThrow(
        /overrides.*requires.*extends/i,
      );
    });
  });

  describe('extends with full phases replacement', () => {
    it('replaces all base phases when child specifies phases (no overrides)', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: replaced-phases
phases:
  - name: custom-only
    steps:
      - name: custom-step
        action: shell
        command: echo custom
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });
      const result = await loadWorkflowWithExtends(childPath, resolver);

      expect(result.name).toBe('replaced-phases');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.name).toBe('custom-only');
    });
  });

  describe('extends + phases + overrides.phases mutually exclusive', () => {
    it('throws WorkflowOverrideError when both phases and overrides.phases are present with extends', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: ambiguous
phases:
  - name: new-phase
    steps:
      - name: s
        action: shell
        command: echo
overrides:
  phases:
    build:
      steps:
        - name: s
          action: shell
          command: echo
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });

      await expect(loadWorkflowWithExtends(childPath, resolver)).rejects.toThrow(
        WorkflowOverrideError,
      );
      await expect(loadWorkflowWithExtends(childPath, resolver)).rejects.toThrow(
        /Cannot specify both "phases" and "overrides.phases"/,
      );
    });
  });

  describe('merged result validation', () => {
    it('validates the merged result against the strict WorkflowDefinitionSchema', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: valid-child
overrides:
  phases:
    build:
      steps:
        - name: new-build
          action: shell
          command: make build
  env:
    NODE_ENV: production
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });
      const result = await loadWorkflowWithExtends(childPath, resolver);

      // Should have all required fields
      expect(result.name).toBe('valid-child');
      expect(result.phases).toBeDefined();
      expect(result.phases.length).toBeGreaterThan(0);
      for (const phase of result.phases) {
        expect(phase.name).toBeDefined();
        expect(phase.steps.length).toBeGreaterThan(0);
        for (const step of phase.steps) {
          expect(step.name).toBeDefined();
          expect(step.action).toBeDefined();
        }
      }
    });

    it('rejects a merged result that violates the schema (e.g., empty phase steps)', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      // Override a phase to have zero steps — the merged result should fail validation
      const childYaml = `
extends: base-workflow
name: invalid-merge
overrides:
  phases:
    build:
      steps: []
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      const resolver = createResolver({ 'base-workflow': basePath });

      // mergeWorkflows allows empty steps (it doesn't validate), but
      // the schema requires at least 1 step per phase — so validation should fail
      // Note: The merge function itself doesn't reject empty steps for existing phases.
      // The steps array is replaced directly. Schema validation catches it.
      await expect(loadWorkflowWithExtends(childPath, resolver)).rejects.toThrow(
        /validation failed/i,
      );
    });
  });

  describe('file errors', () => {
    it('throws when the workflow file does not exist', async () => {
      const resolver = createResolver({});
      const missingPath = join(tempDir, 'does-not-exist.yaml');

      await expect(loadWorkflowWithExtends(missingPath, resolver)).rejects.toThrow(
        /Workflow file not found/,
      );
    });

    it('throws when the workflow file contains invalid YAML', async () => {
      const filePath = writeYaml(tempDir, 'bad-yaml.yaml', ':\n  invalid: [yaml\n  broken');
      const resolver = createResolver({});

      await expect(loadWorkflowWithExtends(filePath, resolver)).rejects.toThrow(
        /Failed to parse workflow YAML/,
      );
    });
  });

  describe('resolver excludePath behavior', () => {
    it('passes the current file path as excludePath to the resolver', async () => {
      const basePath = writeYaml(tempDir, 'base.yaml', BASE_WORKFLOW_YAML);

      const childYaml = `
extends: base-workflow
name: child
`.trimStart();
      const childPath = writeYaml(tempDir, 'child.yaml', childYaml);

      let capturedExcludePath: string | undefined;
      const resolver: WorkflowResolver = (name: string, excludePath?: string) => {
        capturedExcludePath = excludePath;
        if (name === 'base-workflow') return basePath;
        throw new BaseWorkflowNotFoundError(name, []);
      };

      await loadWorkflowWithExtends(childPath, resolver);

      expect(capturedExcludePath).toBe(resolve(childPath));
    });
  });
});
