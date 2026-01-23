/**
 * Tests for variable interpolation engine
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  interpolate,
  interpolateValue,
  parseVariableReference,
  extractVariableReferences,
  hasVariables,
  ExecutionContext,
  type InterpolationContext,
} from '../index';
import type { StepOutput } from '../../actions/types';

describe('Variable Interpolation', () => {
  let context: InterpolationContext;

  beforeEach(() => {
    context = {
      inputs: {
        issueNumber: 42,
        title: 'Test Issue',
        tags: ['bug', 'urgent'],
        config: {
          timeout: 30,
          retries: 3,
        },
      },
      steps: {
        build: {
          raw: '{"version":"1.0.0","artifacts":["dist/app.js"]}',
          parsed: { version: '1.0.0', artifacts: ['dist/app.js'] },
          exitCode: 0,
          completedAt: new Date('2024-01-01'),
        },
        test: {
          raw: 'All tests passed',
          parsed: null,
          exitCode: 0,
          completedAt: new Date('2024-01-01'),
        },
      },
      env: {
        NODE_ENV: 'production',
        CI: 'true',
      },
      functions: {
        success: () => true,
        failure: () => false,
        always: () => true,
      },
    };
  });

  describe('parseVariableReference', () => {
    it('should parse inputs reference', () => {
      const ref = parseVariableReference('inputs.issueNumber');
      expect(ref.type).toBe('inputs');
      expect(ref.path).toEqual(['issueNumber']);
    });

    it('should parse steps reference', () => {
      const ref = parseVariableReference('steps.build.output.version');
      expect(ref.type).toBe('steps');
      expect(ref.path).toEqual(['build', 'output', 'version']);
    });

    it('should parse env reference', () => {
      const ref = parseVariableReference('env.NODE_ENV');
      expect(ref.type).toBe('env');
      expect(ref.path).toEqual(['NODE_ENV']);
    });

    it('should parse function reference', () => {
      const ref = parseVariableReference('success()');
      expect(ref.type).toBe('function');
    });

    it('should handle unknown references', () => {
      const ref = parseVariableReference('unknown.path');
      expect(ref.type).toBe('unknown');
    });
  });

  describe('interpolate', () => {
    it('should interpolate simple input variables', () => {
      const result = interpolate('Issue #${inputs.issueNumber}', context);
      expect(result).toBe('Issue #42');
    });

    it('should interpolate string input variables', () => {
      const result = interpolate('Title: ${inputs.title}', context);
      expect(result).toBe('Title: Test Issue');
    });

    it('should interpolate nested input variables', () => {
      const result = interpolate('Timeout: ${inputs.config.timeout}s', context);
      expect(result).toBe('Timeout: 30s');
    });

    it('should interpolate array access', () => {
      const result = interpolate('First tag: ${inputs.tags.0}', context);
      expect(result).toBe('First tag: bug');
    });

    it('should interpolate step output', () => {
      const result = interpolate('Version: ${steps.build.output.version}', context);
      expect(result).toBe('Version: 1.0.0');
    });

    it('should interpolate step output array', () => {
      const result = interpolate('Artifact: ${steps.build.output.artifacts.0}', context);
      expect(result).toBe('Artifact: dist/app.js');
    });

    it('should interpolate raw step output', () => {
      const result = interpolate('Output: ${steps.test.raw}', context);
      expect(result).toBe('Output: All tests passed');
    });

    it('should interpolate environment variables', () => {
      const result = interpolate('Env: ${env.NODE_ENV}', context);
      expect(result).toBe('Env: production');
    });

    it('should handle multiple variables in one template', () => {
      const result = interpolate(
        'Issue #${inputs.issueNumber}: ${inputs.title} (${env.NODE_ENV})',
        context
      );
      expect(result).toBe('Issue #42: Test Issue (production)');
    });

    it('should return empty string for missing variables by default', () => {
      const result = interpolate('Value: ${inputs.missing}', context);
      expect(result).toBe('Value: ');
    });

    it('should return custom default value for missing variables', () => {
      const result = interpolate('Value: ${inputs.missing}', context, {
        defaultValue: 'N/A',
      });
      expect(result).toBe('Value: N/A');
    });

    it('should throw in strict mode for missing variables', () => {
      expect(() => {
        interpolate('Value: ${inputs.missing}', context, { strict: true });
      }).toThrow('Unresolved variable: inputs.missing');
    });

    it('should handle templates without variables', () => {
      const result = interpolate('No variables here', context);
      expect(result).toBe('No variables here');
    });

    it('should coerce objects to JSON strings', () => {
      const result = interpolate('Config: ${inputs.config}', context);
      expect(result).toBe('Config: {"timeout":30,"retries":3}');
    });

    it('should coerce arrays to JSON strings', () => {
      const result = interpolate('Tags: ${inputs.tags}', context);
      expect(result).toBe('Tags: ["bug","urgent"]');
    });
  });

  describe('interpolateValue', () => {
    it('should interpolate string values', () => {
      const result = interpolateValue('Issue #${inputs.issueNumber}', context);
      expect(result).toBe('Issue #42');
    });

    it('should interpolate values in objects', () => {
      const result = interpolateValue(
        {
          title: 'Issue #${inputs.issueNumber}',
          env: '${env.NODE_ENV}',
        },
        context
      );
      expect(result).toEqual({
        title: 'Issue #42',
        env: 'production',
      });
    });

    it('should interpolate values in arrays', () => {
      const result = interpolateValue(
        ['${inputs.title}', '${env.NODE_ENV}'],
        context
      );
      expect(result).toEqual(['Test Issue', 'production']);
    });

    it('should interpolate nested structures', () => {
      const result = interpolateValue(
        {
          issue: {
            number: '${inputs.issueNumber}',
            tags: ['${inputs.tags.0}', '${inputs.tags.1}'],
          },
        },
        context
      );
      expect(result).toEqual({
        issue: {
          number: '42',
          tags: ['bug', 'urgent'],
        },
      });
    });

    it('should pass through non-string primitives', () => {
      expect(interpolateValue(42, context)).toBe(42);
      expect(interpolateValue(true, context)).toBe(true);
      expect(interpolateValue(null, context)).toBe(null);
    });
  });

  describe('extractVariableReferences', () => {
    it('should extract all variable references', () => {
      const refs = extractVariableReferences(
        '${inputs.a} and ${steps.b.output} and ${env.C}'
      );
      expect(refs).toHaveLength(3);
      expect(refs[0]?.type).toBe('inputs');
      expect(refs[1]?.type).toBe('steps');
      expect(refs[2]?.type).toBe('env');
    });

    it('should return empty array for no variables', () => {
      const refs = extractVariableReferences('No variables here');
      expect(refs).toHaveLength(0);
    });
  });

  describe('hasVariables', () => {
    it('should return true for templates with variables', () => {
      expect(hasVariables('Value: ${inputs.x}')).toBe(true);
    });

    it('should return false for templates without variables', () => {
      expect(hasVariables('No variables here')).toBe(false);
    });
  });
});

describe('ExecutionContext', () => {
  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = new ExecutionContext(
      { issueNumber: 123 },
      { NODE_ENV: 'test' }
    );
  });

  describe('inputs management', () => {
    it('should store and retrieve inputs', () => {
      ctx.setInput('key', 'value');
      expect(ctx.getInput('key')).toBe('value');
    });

    it('should return all inputs', () => {
      expect(ctx.getInputs()).toEqual({ issueNumber: 123 });
    });
  });

  describe('environment management', () => {
    it('should store and retrieve env vars', () => {
      ctx.setEnv('NEW_VAR', 'value');
      expect(ctx.getEnv('NEW_VAR')).toBe('value');
    });

    it('should return all env vars', () => {
      expect(ctx.getEnvironment()).toEqual({ NODE_ENV: 'test' });
    });
  });

  describe('step outputs', () => {
    it('should store and retrieve step outputs', () => {
      const output: StepOutput = {
        raw: 'output',
        parsed: { data: 'value' },
        exitCode: 0,
        completedAt: new Date(),
      };
      ctx.setStepOutput('step1', output);
      expect(ctx.getStepOutput('step1')).toEqual(output);
    });

    it('should check if step output exists', () => {
      expect(ctx.hasStepOutput('step1')).toBe(false);
      ctx.setStepOutput('step1', {
        raw: '',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      });
      expect(ctx.hasStepOutput('step1')).toBe(true);
    });

    it('should clear step outputs', () => {
      ctx.setStepOutput('step1', {
        raw: '',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      });
      ctx.clearStepOutput('step1');
      expect(ctx.hasStepOutput('step1')).toBe(false);
    });
  });

  describe('variable resolution', () => {
    it('should resolve input variables', () => {
      expect(ctx.resolveVariable('inputs.issueNumber')).toBe(123);
    });

    it('should resolve env variables', () => {
      expect(ctx.resolveVariable('env.NODE_ENV')).toBe('test');
    });

    it('should resolve step output variables', () => {
      ctx.setStepOutput('build', {
        raw: '{"version":"1.0"}',
        parsed: { version: '1.0' },
        exitCode: 0,
        completedAt: new Date(),
      });
      expect(ctx.resolveVariable('steps.build.output.version')).toBe('1.0');
    });

    it('should return undefined for missing paths', () => {
      expect(ctx.resolveVariable('inputs.missing')).toBeUndefined();
      expect(ctx.resolveVariable('steps.missing.output')).toBeUndefined();
    });
  });

  describe('interpolation context', () => {
    it('should create valid interpolation context', () => {
      const interpCtx = ctx.getInterpolationContext();
      expect(interpCtx.inputs).toEqual({ issueNumber: 123 });
      expect(interpCtx.env).toEqual({ NODE_ENV: 'test' });
      expect(interpCtx.functions.always()).toBe(true);
    });

    it('should track success/failure state', () => {
      ctx.setStepOutput('step1', {
        raw: '',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      });
      expect(ctx.getInterpolationContext().functions.success()).toBe(true);

      ctx.setStepOutput('step2', {
        raw: '',
        parsed: null,
        exitCode: 1,
        completedAt: new Date(),
      });
      expect(ctx.getInterpolationContext().functions.failure()).toBe(true);
    });
  });

  describe('child context', () => {
    it('should create a child context with inherited values', () => {
      ctx.setStepOutput('step1', {
        raw: 'test',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      });

      const child = ctx.createChildContext();
      expect(child.getInput('issueNumber')).toBe(123);
      expect(child.getEnv('NODE_ENV')).toBe('test');
      expect(child.hasStepOutput('step1')).toBe(true);
    });

    it('should not affect parent when modified', () => {
      const child = ctx.createChildContext();
      child.setInput('newKey', 'newValue');
      expect(ctx.getInput('newKey')).toBeUndefined();
    });
  });
});

describe('Edge Cases', () => {
  let context: InterpolationContext;

  beforeEach(() => {
    context = {
      inputs: {},
      steps: {},
      env: {},
      functions: {
        success: () => true,
        failure: () => false,
        always: () => true,
      },
    };
  });

  it('should handle empty templates', () => {
    expect(interpolate('', context)).toBe('');
  });

  it('should handle malformed variable syntax', () => {
    // Unclosed braces should be left as-is
    expect(interpolate('${unclosed', context)).toBe('${unclosed');
  });

  it('should handle deeply nested paths', () => {
    context.inputs = {
      a: { b: { c: { d: { e: 'deep' } } } },
    };
    expect(interpolate('${inputs.a.b.c.d.e}', context)).toBe('deep');
  });

  it('should handle null values in output', () => {
    context.steps = {
      step1: {
        raw: 'null',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      },
    };
    // When parsed is null, should fall back to raw
    expect(interpolate('${steps.step1.output}', context)).toBe('null');
  });

  it('should handle step output with no parsed value', () => {
    context.steps = {
      step1: {
        raw: 'raw text output',
        parsed: null,
        exitCode: 0,
        completedAt: new Date(),
      },
    };
    expect(interpolate('${steps.step1.output}', context)).toBe('raw text output');
  });

  it('should handle bracket notation in paths', () => {
    context.inputs = {
      items: [{ name: 'first' }, { name: 'second' }],
    };
    expect(interpolate('${inputs.items.0.name}', context)).toBe('first');
  });
});
