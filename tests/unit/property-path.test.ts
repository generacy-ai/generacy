/**
 * Property Path Parser Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  parseValue,
  getValueAtPath,
  compare,
  evaluateExpression,
  evaluateAll,
  evaluateAny,
} from '../../src/utils/PropertyPathParser.js';

describe('PropertyPathParser', () => {
  describe('parseValue', () => {
    it('parses boolean true', () => {
      expect(parseValue('true')).toBe(true);
    });

    it('parses boolean false', () => {
      expect(parseValue('false')).toBe(false);
    });

    it('parses null', () => {
      expect(parseValue('null')).toBe(null);
    });

    it('parses undefined', () => {
      expect(parseValue('undefined')).toBe(undefined);
    });

    it('parses integers', () => {
      expect(parseValue('42')).toBe(42);
      expect(parseValue('-10')).toBe(-10);
    });

    it('parses floats', () => {
      expect(parseValue('3.14')).toBe(3.14);
      expect(parseValue('-0.5')).toBe(-0.5);
    });

    it('parses double-quoted strings', () => {
      expect(parseValue('"hello"')).toBe('hello');
    });

    it('parses single-quoted strings', () => {
      expect(parseValue("'world'")).toBe('world');
    });

    it('returns unquoted strings as-is', () => {
      expect(parseValue('approved')).toBe('approved');
    });
  });

  describe('parseExpression', () => {
    it('parses equality expression', () => {
      const result = parseExpression('status == approved');
      expect(result).toEqual({
        path: 'status',
        operator: '==',
        value: 'approved',
      });
    });

    it('parses nested path expression', () => {
      const result = parseExpression('context.data.status == "active"');
      expect(result).toEqual({
        path: 'context.data.status',
        operator: '==',
        value: 'active',
      });
    });

    it('parses numeric comparison', () => {
      const result = parseExpression('count > 10');
      expect(result).toEqual({
        path: 'count',
        operator: '>',
        value: 10,
      });
    });

    it('parses not-equal expression', () => {
      const result = parseExpression('status != failed');
      expect(result).toEqual({
        path: 'status',
        operator: '!=',
        value: 'failed',
      });
    });

    it('parses contains expression', () => {
      const result = parseExpression('name contains "test"');
      expect(result).toEqual({
        path: 'name',
        operator: 'contains',
        value: 'test',
      });
    });

    it('parses startsWith expression', () => {
      const result = parseExpression('prefix startsWith "wf_"');
      expect(result).toEqual({
        path: 'prefix',
        operator: 'startsWith',
        value: 'wf_',
      });
    });

    it('throws on invalid expression', () => {
      expect(() => parseExpression('invalid')).toThrow('Invalid expression format');
    });
  });

  describe('getValueAtPath', () => {
    const obj = {
      name: 'test',
      nested: {
        value: 42,
        deep: {
          flag: true,
        },
      },
      items: ['a', 'b', 'c'],
    };

    it('gets top-level value', () => {
      expect(getValueAtPath(obj, 'name')).toBe('test');
    });

    it('gets nested value', () => {
      expect(getValueAtPath(obj, 'nested.value')).toBe(42);
    });

    it('gets deeply nested value', () => {
      expect(getValueAtPath(obj, 'nested.deep.flag')).toBe(true);
    });

    it('returns undefined for missing path', () => {
      expect(getValueAtPath(obj, 'missing.path')).toBe(undefined);
    });

    it('returns undefined for null input', () => {
      expect(getValueAtPath(null, 'path')).toBe(undefined);
    });

    it('handles array index notation', () => {
      expect(getValueAtPath(obj, 'items[0]')).toBe('a');
      expect(getValueAtPath(obj, 'items[2]')).toBe('c');
    });
  });

  describe('compare', () => {
    it('compares equality', () => {
      expect(compare('a', '==', 'a')).toBe(true);
      expect(compare('a', '==', 'b')).toBe(false);
      expect(compare(1, '==', 1)).toBe(true);
    });

    it('compares inequality', () => {
      expect(compare('a', '!=', 'b')).toBe(true);
      expect(compare('a', '!=', 'a')).toBe(false);
    });

    it('compares greater than', () => {
      expect(compare(10, '>', 5)).toBe(true);
      expect(compare(5, '>', 10)).toBe(false);
      expect(compare('a', '>', 'b')).toBe(false); // Non-numeric
    });

    it('compares less than', () => {
      expect(compare(5, '<', 10)).toBe(true);
      expect(compare(10, '<', 5)).toBe(false);
    });

    it('compares greater than or equal', () => {
      expect(compare(10, '>=', 10)).toBe(true);
      expect(compare(10, '>=', 5)).toBe(true);
      expect(compare(5, '>=', 10)).toBe(false);
    });

    it('compares less than or equal', () => {
      expect(compare(5, '<=', 10)).toBe(true);
      expect(compare(10, '<=', 10)).toBe(true);
      expect(compare(10, '<=', 5)).toBe(false);
    });

    it('checks string contains', () => {
      expect(compare('hello world', 'contains', 'world')).toBe(true);
      expect(compare('hello', 'contains', 'world')).toBe(false);
    });

    it('checks array contains', () => {
      expect(compare(['a', 'b', 'c'], 'contains', 'b')).toBe(true);
      expect(compare(['a', 'b', 'c'], 'contains', 'd')).toBe(false);
    });

    it('checks startsWith', () => {
      expect(compare('workflow_123', 'startsWith', 'workflow_')).toBe(true);
      expect(compare('workflow_123', 'startsWith', 'task_')).toBe(false);
    });

    it('checks endsWith', () => {
      expect(compare('file.txt', 'endsWith', '.txt')).toBe(true);
      expect(compare('file.txt', 'endsWith', '.md')).toBe(false);
    });
  });

  describe('evaluateExpression', () => {
    const context = {
      status: 'approved',
      count: 42,
      user: {
        name: 'Alice',
        role: 'admin',
      },
      tags: ['important', 'urgent'],
    };

    it('evaluates simple equality', () => {
      const result = evaluateExpression('status == approved', context);
      expect(result.result).toBe(true);
      expect(result.resolvedValue).toBe('approved');
    });

    it('evaluates nested path', () => {
      const result = evaluateExpression('user.role == admin', context);
      expect(result.result).toBe(true);
    });

    it('evaluates numeric comparison', () => {
      const result = evaluateExpression('count > 10', context);
      expect(result.result).toBe(true);
    });

    it('returns false for non-matching expression', () => {
      const result = evaluateExpression('status == rejected', context);
      expect(result.result).toBe(false);
    });

    it('returns error for invalid expression', () => {
      const result = evaluateExpression('invalid', context);
      expect(result.result).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('evaluateAll', () => {
    const context = {
      status: 'active',
      count: 50,
    };

    it('returns true when all expressions match', () => {
      const result = evaluateAll(
        ['status == active', 'count > 10'],
        context
      );
      expect(result.result).toBe(true);
    });

    it('returns false when any expression fails', () => {
      const result = evaluateAll(
        ['status == active', 'count < 10'],
        context
      );
      expect(result.result).toBe(false);
    });
  });

  describe('evaluateAny', () => {
    const context = {
      status: 'pending',
      count: 5,
    };

    it('returns true when any expression matches', () => {
      const result = evaluateAny(
        ['status == active', 'status == pending'],
        context
      );
      expect(result.result).toBe(true);
    });

    it('returns false when no expression matches', () => {
      const result = evaluateAny(
        ['status == active', 'count > 100'],
        context
      );
      expect(result.result).toBe(false);
    });
  });
});
