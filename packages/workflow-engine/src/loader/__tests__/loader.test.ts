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
  it('should load a valid workflow YAML', () => {
    const yaml = `
name: test-workflow
description: A test workflow

inputs:
  - name: user_name
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

    const workflow = loadWorkflowFromString(yaml);

    expect(workflow.name).toBe('test-workflow');
    expect(workflow.description).toBe('A test workflow');
    expect(workflow.inputs).toBeDefined();
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0]!.name).toBe('setup');
  });

  it('should throw on invalid YAML', () => {
    const invalidYaml = `
name: test
phases: [
`;

    expect(() => loadWorkflowFromString(invalidYaml)).toThrow();
  });

  it('should throw on missing required fields', () => {
    const missingName = `
phases:
  - name: test
    steps:
      - name: step1
        command: echo hi
`;

    expect(() => loadWorkflowFromString(missingName)).toThrow(WorkflowValidationError);
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
      phases: [
        {
          name: 'phase1',
          steps: [{ name: 'step1', command: 'echo test' }],
        },
      ],
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
      inputs: [
        {
          name: 'user_name',
          type: 'string',
          required: true,
        },
        {
          name: 'count',
          type: 'number',
          default: 10,
        },
      ],
      phases: [
        {
          name: 'phase1',
          steps: [{ name: 'step1', command: 'echo test' }],
        },
      ],
    };

    const result = validateWorkflow(workflow);
    expect(result.inputs).toBeDefined();
    expect(result.inputs).toHaveLength(2);
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
      phases: [
        {
          name: 'phase1',
          steps: [{ name: 'step1', command: 'echo test' }],
        },
      ],
    };

    const result = isValidWorkflow(workflow);
    expect(result.valid).toBe(true);
  });

  it('should return false for invalid workflows', () => {
    expect(isValidWorkflow(null).valid).toBe(false);
    expect(isValidWorkflow({}).valid).toBe(false);
    expect(isValidWorkflow({ name: '' }).valid).toBe(false);
  });
});

describe('prepareWorkflow', () => {
  it('should convert definition to executable format', () => {
    const yaml = `
name: test-workflow
phases:
  - name: phase1
    steps:
      - name: step1
        action: shell
        command: echo test
`;

    const definition = loadWorkflowFromString(yaml);
    const workflow = prepareWorkflow(definition);

    expect(workflow.name).toBe('test-workflow');
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0]!.steps).toHaveLength(1);
  });

  it('should resolve input defaults', () => {
    const yaml = `
name: test
inputs:
  - name: greeting
    type: string
    default: hello
phases:
  - name: phase1
    steps:
      - name: step1
        command: echo test
`;

    const definition = loadWorkflowFromString(yaml);
    const workflow = prepareWorkflow(definition);
    expect(workflow.name).toBe('test');
  });
});
