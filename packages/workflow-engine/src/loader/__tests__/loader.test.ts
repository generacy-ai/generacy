/**
 * Tests for workflow loader and validation
 */
import { describe, it, expect } from 'vitest';
import {
  loadWorkflowFromString,
  prepareWorkflow,
  validateWorkflow,
  isValidWorkflow,
  WorkflowValidationError,
} from '../index.js';

describe('loadWorkflowFromString', () => {
  it('should load a valid workflow YAML', async () => {
    const yaml = `
name: test-workflow
description: A test workflow

inputs:
  name:
    type: string
    required: true
    description: User name

phases:
  - name: setup
    steps:
      - name: greet
        action: shell
        command: echo "Hello"
`;

    const workflow = await loadWorkflowFromString(yaml);

    expect(workflow.name).toBe('test-workflow');
    expect(workflow.description).toBe('A test workflow');
    expect(workflow.inputs).toBeDefined();
    expect(workflow.inputs!['name']).toBeDefined();
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0]!.name).toBe('setup');
  });

  it('should throw on invalid YAML', async () => {
    const invalidYaml = `
name: test
phases:
  - this is not valid yaml structure
    indentation: broken
`;

    await expect(loadWorkflowFromString(invalidYaml)).rejects.toThrow();
  });

  it('should throw on missing required fields', async () => {
    const missingName = `
phases:
  - name: test
    steps: []
`;

    await expect(loadWorkflowFromString(missingName)).rejects.toThrow(WorkflowValidationError);
  });
});

describe('validateWorkflow', () => {
  it('should validate a correct workflow', () => {
    const workflow = {
      name: 'valid-workflow',
      phases: [
        {
          name: 'phase1',
          steps: [
            {
              name: 'step1',
              action: 'shell',
              command: 'echo test',
            },
          ],
        },
      ],
    };

    const result = validateWorkflow(workflow);
    expect(result.name).toBe('valid-workflow');
  });

  it('should throw on empty name', () => {
    const workflow = {
      name: '',
      phases: [],
    };

    expect(() => validateWorkflow(workflow)).toThrow(WorkflowValidationError);
  });

  it('should throw on missing phases', () => {
    const workflow = {
      name: 'test',
    };

    expect(() => validateWorkflow(workflow as never)).toThrow(WorkflowValidationError);
  });

  it('should validate input definitions', () => {
    const workflow = {
      name: 'with-inputs',
      inputs: {
        name: {
          type: 'string',
          required: true,
        },
        count: {
          type: 'number',
          default: 10,
        },
      },
      phases: [],
    };

    const result = validateWorkflow(workflow);
    expect(result.inputs!['name']!.required).toBe(true);
    expect(result.inputs!['count']!.default).toBe(10);
  });

  it('should validate retry configuration', () => {
    const workflow = {
      name: 'with-retry',
      phases: [
        {
          name: 'phase1',
          steps: [
            {
              name: 'flaky-step',
              action: 'shell',
              command: 'curl example.com',
              retry: {
                maxAttempts: 3,
                backoff: 'exponential',
                delay: '1s',
                maxDelay: '30s',
              },
            },
          ],
        },
      ],
    };

    const result = validateWorkflow(workflow);
    expect(result.phases[0]!.steps[0]!.retry!.maxAttempts).toBe(3);
  });
});

describe('isValidWorkflow', () => {
  it('should return true for valid workflows', () => {
    const workflow = {
      name: 'valid',
      phases: [],
    };

    expect(isValidWorkflow(workflow)).toBe(true);
  });

  it('should return false for invalid workflows', () => {
    expect(isValidWorkflow(null)).toBe(false);
    expect(isValidWorkflow({})).toBe(false);
    expect(isValidWorkflow({ name: '' })).toBe(false);
  });
});

describe('prepareWorkflow', () => {
  it('should convert definition to executable format', () => {
    const definition = {
      name: 'test-workflow',
      phases: [
        {
          name: 'phase1',
          steps: [
            {
              name: 'step1',
              action: 'shell',
              command: 'echo test',
            },
          ],
        },
      ],
    };

    const workflow = prepareWorkflow(definition);

    expect(workflow.name).toBe('test-workflow');
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0]!.steps).toHaveLength(1);
  });

  it('should generate IDs for phases and steps', () => {
    const definition = {
      name: 'test',
      phases: [
        {
          name: 'phase1',
          steps: [
            { name: 'step1', action: 'shell', command: 'test' },
            { name: 'step2', action: 'shell', command: 'test' },
          ],
        },
      ],
    };

    const workflow = prepareWorkflow(definition);

    expect(workflow.phases[0]!.id).toBeDefined();
    expect(workflow.phases[0]!.steps[0]!.id).toBeDefined();
    expect(workflow.phases[0]!.steps[1]!.id).toBeDefined();
  });
});
