/**
 * Property Path Parser
 *
 * Parse and evaluate property path expressions for condition evaluation.
 * Supports expressions like "context.data.status == approved"
 */

/**
 * Supported comparison operators
 */
export type ComparisonOperator = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'startsWith' | 'endsWith';

/**
 * Parsed expression structure
 */
export interface ParsedExpression {
  /** Left-hand side property path */
  path: string;

  /** Comparison operator */
  operator: ComparisonOperator;

  /** Right-hand side value */
  value: unknown;
}

/**
 * Result of evaluating an expression
 */
export interface EvaluationResult {
  /** Whether the expression evaluated to true */
  result: boolean;

  /** The resolved value from the path */
  resolvedValue: unknown;

  /** Any error that occurred */
  error?: string;
}

/**
 * Parse a property path expression into its components.
 *
 * Supported formats:
 * - "path.to.value == expectedValue"
 * - "path.to.value != expectedValue"
 * - "path.to.value > 10"
 * - "path.to.value contains substring"
 *
 * @param expression The expression to parse
 * @returns Parsed expression components
 * @throws If the expression is malformed
 */
export function parseExpression(expression: string): ParsedExpression {
  const trimmed = expression.trim();

  // Match operator pattern
  const operatorPattern = /^(.+?)\s*(==|!=|>=|<=|>|<|contains|startsWith|endsWith)\s*(.+)$/;
  const match = trimmed.match(operatorPattern);

  if (!match) {
    throw new Error(`Invalid expression format: "${expression}". Expected format: "path operator value"`);
  }

  const [, pathStr, operatorStr, valueStr] = match;

  if (!pathStr || !operatorStr || !valueStr) {
    throw new Error(`Invalid expression format: "${expression}"`);
  }

  const path = pathStr.trim();
  const operator = operatorStr as ComparisonOperator;
  const value = parseValue(valueStr.trim());

  return { path, operator, value };
}

/**
 * Parse a value string into the appropriate type.
 */
export function parseValue(valueStr: string): unknown {
  // Boolean
  if (valueStr === 'true') return true;
  if (valueStr === 'false') return false;

  // Null
  if (valueStr === 'null') return null;

  // Undefined
  if (valueStr === 'undefined') return undefined;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(valueStr)) {
    return parseFloat(valueStr);
  }

  // Quoted string
  if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
      (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
    return valueStr.slice(1, -1);
  }

  // Unquoted string (identifier)
  return valueStr;
}

/**
 * Get a value from an object using a dot-notation path.
 *
 * @param obj The object to traverse
 * @param path The dot-notation path (e.g., "context.data.status")
 * @returns The value at the path, or undefined if not found
 */
export function getValueAtPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    // Handle array index notation: items[0]
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, propName, indexStr] = arrayMatch;
      if (!propName) return undefined;
      const index = parseInt(indexStr ?? '0', 10);
      const arr = (current as Record<string, unknown>)[propName];
      if (!Array.isArray(arr)) {
        return undefined;
      }
      current = arr[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Compare two values using the specified operator.
 */
export function compare(left: unknown, operator: ComparisonOperator, right: unknown): boolean {
  switch (operator) {
    case '==':
      return left === right;

    case '!=':
      return left !== right;

    case '>':
      if (typeof left === 'number' && typeof right === 'number') {
        return left > right;
      }
      return false;

    case '<':
      if (typeof left === 'number' && typeof right === 'number') {
        return left < right;
      }
      return false;

    case '>=':
      if (typeof left === 'number' && typeof right === 'number') {
        return left >= right;
      }
      return false;

    case '<=':
      if (typeof left === 'number' && typeof right === 'number') {
        return left <= right;
      }
      return false;

    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') {
        return left.includes(right);
      }
      if (Array.isArray(left)) {
        return left.includes(right);
      }
      return false;

    case 'startsWith':
      if (typeof left === 'string' && typeof right === 'string') {
        return left.startsWith(right);
      }
      return false;

    case 'endsWith':
      if (typeof left === 'string' && typeof right === 'string') {
        return left.endsWith(right);
      }
      return false;

    default:
      return false;
  }
}

/**
 * Evaluate an expression against a context object.
 *
 * @param expression The expression to evaluate
 * @param context The context object to evaluate against
 * @returns Evaluation result
 */
export function evaluateExpression(expression: string, context: unknown): EvaluationResult {
  try {
    const parsed = parseExpression(expression);
    const resolvedValue = getValueAtPath(context, parsed.path);
    const result = compare(resolvedValue, parsed.operator, parsed.value);

    return {
      result,
      resolvedValue,
    };
  } catch (error) {
    return {
      result: false,
      resolvedValue: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Evaluate multiple expressions with AND logic.
 */
export function evaluateAll(expressions: string[], context: unknown): EvaluationResult {
  for (const expr of expressions) {
    const result = evaluateExpression(expr, context);
    if (!result.result) {
      return result;
    }
  }

  return {
    result: true,
    resolvedValue: undefined,
  };
}

/**
 * Evaluate multiple expressions with OR logic.
 */
export function evaluateAny(expressions: string[], context: unknown): EvaluationResult {
  for (const expr of expressions) {
    const result = evaluateExpression(expr, context);
    if (result.result) {
      return result;
    }
  }

  return {
    result: false,
    resolvedValue: undefined,
  };
}
