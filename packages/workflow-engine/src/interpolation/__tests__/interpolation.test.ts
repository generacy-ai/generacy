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

describe('parseVariableReference', () => {
  it('should parse inputs references', () => {
    const ref = parseVariableReference('${inputs.name}');
    expect(ref).toEqual({
      type: 'inputs',
      path: ['name'],
    });
  });

  it('should parse steps references', () => {
    const ref = parseVariableReference('${steps.build.output.path}');
    expect(ref).toEqual({
      type: 'steps',
      path: ['build', 'output', 'path'],
    });
  });

  it('should parse env references', () => {
    const ref = parseVariableReference('${env.HOME}');
    expect(ref).toEqual({
      type: 'env',
      path: ['HOME'],
    });
  });

  it('should return undefined for invalid references', () => {
    expect(parseVariableReference('${invalid}')).toBeUndefined();
    expect(parseVariableReference('${}')).toBeUndefined();
    expect(parseVariableReference('not a reference')).toBeUndefined();
  });
});

describe('extractVariableReferences', () => {
  it('should extract multiple references', () => {
    const text = 'Hello ${inputs.name}, your home is ${env.HOME}';
    const refs = extractVariableReferences(text);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ type: 'inputs', path: ['name'] });
    expect(refs[1]).toEqual({ type: 'env', path: ['HOME'] });
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

  it('should detect variables in objects', () => {
    expect(hasVariables({ key: '${inputs.x}' })).toBe(true);
    expect(hasVariables({ key: 'plain' })).toBe(false);
  });

  it('should detect variables in arrays', () => {
    expect(hasVariables(['${inputs.x}', 'plain'])).toBe(true);
    expect(hasVariables(['plain', 'text'])).toBe(false);
  });
});

describe('interpolate', () => {
  const context = {
    inputs: { name: 'Alice', count: 5 },
    steps: new Map([
      ['build', { output: { path: '/dist', success: true } }],
    ]),
    env: { HOME: '/home/user', NODE_ENV: 'test' },
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
    ctx.setStepOutput('build', { path: '/dist' });

    expect(ctx.getStepOutput('build')).toEqual({ path: '/dist' });
    expect(ctx.getStepOutput('missing')).toBeUndefined();
  });

  it('should manage env variables', () => {
    const ctx = new ExecutionContext();
    ctx.setEnv({ HOME: '/home/test' });

    expect(ctx.getEnv('HOME')).toBe('/home/test');
    expect(ctx.getEnv('MISSING')).toBeUndefined();
  });

  it('should create interpolation context', () => {
    const ctx = new ExecutionContext();
    ctx.setInputs({ name: 'Test' });
    ctx.setStepOutput('build', { success: true });
    ctx.setEnv({ HOME: '/home' });

    const interpolationCtx = ctx.toInterpolationContext();

    expect(interpolationCtx.inputs).toEqual({ name: 'Test' });
    expect(interpolationCtx.steps.get('build')).toEqual({ success: true });
    expect(interpolationCtx.env).toEqual({ HOME: '/home' });
  });
});
