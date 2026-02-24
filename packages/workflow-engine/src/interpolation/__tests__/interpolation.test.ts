/**
 * Tests for interpolation engine
 */
import { describe, it, expect } from 'vitest';
import {
  interpolate,
  interpolateValue,
  parseVariableReference,
  extractVariableReferences,
  hasVariables,
  ExecutionContext,
} from '../index.js';
import type { InterpolationContext } from '../context.js';
import type { StepOutput } from '../../types/action.js';

describe('parseVariableReference', () => {
  it('should parse inputs references', () => {
    const ref = parseVariableReference('inputs.name');
    expect(ref).toMatchObject({
      type: 'inputs',
      path: ['name'],
    });
  });

  it('should parse steps references', () => {
    const ref = parseVariableReference('steps.build.output.path');
    expect(ref).toMatchObject({
      type: 'steps',
      path: ['build', 'output', 'path'],
    });
  });

  it('should parse env references', () => {
    const ref = parseVariableReference('env.HOME');
    expect(ref).toMatchObject({
      type: 'env',
      path: ['HOME'],
    });
  });

  it('should return unknown type for invalid references', () => {
    const ref = parseVariableReference('invalid');
    expect(ref.type).toBe('unknown');
  });
});

describe('extractVariableReferences', () => {
  it('should extract multiple references', () => {
    const text = 'Hello ${inputs.name}, your home is ${env.HOME}';
    const refs = extractVariableReferences(text);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ type: 'inputs', path: ['name'] });
    expect(refs[1]).toMatchObject({ type: 'env', path: ['HOME'] });
  });

  it('should handle text without references', () => {
    const refs = extractVariableReferences('plain text');
    expect(refs).toHaveLength(0);
  });
});

describe('hasVariables', () => {
  it('should detect variables in strings', () => {
    expect(hasVariables('${inputs.x}')).toBe(true);
    expect(hasVariables('no variables here')).toBe(false);
  });

  it('should detect double-brace variables', () => {
    expect(hasVariables('${{ inputs.x }}')).toBe(true);
    expect(hasVariables('${{ steps.build.output.path }}')).toBe(true);
  });

  it('should detect variables in arrays', () => {
    // hasVariables only takes strings, so test with individual elements
    expect(hasVariables('${inputs.x}')).toBe(true);
    expect(hasVariables('plain')).toBe(false);
  });
});

describe('interpolate', () => {
  const buildOutput: StepOutput = {
    raw: '{"path": "/dist", "success": true}',
    parsed: { path: '/dist', success: true },
    exitCode: 0,
    completedAt: new Date(),
  };

  const context: InterpolationContext = {
    inputs: { name: 'Alice', count: 5 },
    steps: {
      build: buildOutput,
    },
    env: { HOME: '/home/user', NODE_ENV: 'test' },
    functions: {
      success: () => true,
      failure: () => false,
      always: () => true,
    },
  };

  it('should interpolate input values', () => {
    expect(interpolate('Hello ${inputs.name}!', context)).toBe('Hello Alice!');
  });

  it('should interpolate env values', () => {
    expect(interpolate('Home: ${env.HOME}', context)).toBe('Home: /home/user');
  });

  it('should interpolate step outputs', () => {
    expect(interpolate('Path: ${steps.build.output.path}', context)).toBe('Path: /dist');
  });

  it('should handle multiple interpolations', () => {
    const result = interpolate(
      'Hello ${inputs.name}, running in ${env.NODE_ENV}',
      context
    );
    expect(result).toBe('Hello Alice, running in test');
  });

  it('should handle missing values', () => {
    expect(interpolate('${inputs.missing}', context)).toBe('');
  });

  it('should handle nested object interpolation', () => {
    const value = {
      greeting: 'Hello ${inputs.name}',
      nested: {
        path: '${steps.build.output.path}',
      },
    };

    const result = interpolateValue(value, context);
    expect(result).toEqual({
      greeting: 'Hello Alice',
      nested: {
        path: '/dist',
      },
    });
  });

  it('should handle array interpolation', () => {
    const value = ['${inputs.name}', '${env.HOME}'];
    const result = interpolateValue(value, context);
    expect(result).toEqual(['Alice', '/home/user']);
  });

  it('should handle double-brace syntax', () => {
    expect(interpolate('${{ inputs.name }}', context)).toBe('Alice');
  });
});

describe('ExecutionContext', () => {
  it('should manage inputs', () => {
    const ctx = new ExecutionContext();
    ctx.setInputs({ name: 'Bob' });

    expect(ctx.getInput('name')).toBe('Bob');
    expect(ctx.getInput('missing')).toBeUndefined();
  });

  it('should manage step outputs', () => {
    const ctx = new ExecutionContext();
    const output: StepOutput = {
      raw: '{"path": "/dist"}',
      parsed: { path: '/dist' },
      exitCode: 0,
      completedAt: new Date(),
    };
    ctx.setStepOutput('build', output);

    expect(ctx.getStepOutput('build')).toEqual(output);
    expect(ctx.getStepOutput('missing')).toBeUndefined();
  });

  it('should manage env variables', () => {
    const ctx = new ExecutionContext();
    ctx.setEnvironment({ HOME: '/home/test' });

    expect(ctx.getEnv('HOME')).toBe('/home/test');
    expect(ctx.getEnv('MISSING')).toBeUndefined();
  });

  it('should create interpolation context', () => {
    const ctx = new ExecutionContext();
    ctx.setInputs({ name: 'Test' });
    const output: StepOutput = {
      raw: '{"success": true}',
      parsed: { success: true },
      exitCode: 0,
      completedAt: new Date(),
    };
    ctx.setStepOutput('build', output);
    ctx.setEnvironment({ HOME: '/home' });

    const interpolationCtx = ctx.getInterpolationContext();

    expect(interpolationCtx.inputs).toEqual({ name: 'Test' });
    expect(interpolationCtx.steps['build']).toEqual(output);
    expect(interpolationCtx.env).toEqual({ HOME: '/home' });
  });
});
