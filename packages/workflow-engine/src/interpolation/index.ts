/**
 * Variable interpolation engine.
 * Supports ${inputs.*}, ${steps.*}, ${env.*} patterns with deep path resolution.
 */
import type { InterpolationContext } from './context.js';

/**
 * Parsed variable reference
 */
export interface VariableReference {
  /** Full variable expression (e.g., "steps.build.output.version") */
  expression: string;
  /** Type: inputs, steps, env, or function */
  type: 'inputs' | 'steps' | 'env' | 'function' | 'unknown';
  /** Path segments after type */
  path: string[];
}

/**
 * Interpolation options
 */
export interface InterpolateOptions {
  /** Whether to throw on unresolved variables (default: false, returns empty string) */
  strict?: boolean;
  /** Default value for unresolved variables */
  defaultValue?: string;
  /** Whether to coerce non-string values to strings (default: true) */
  coerceToString?: boolean;
}

/**
 * Regular expression for matching variable expressions
 * Matches ${...} patterns
 */
const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Parse a variable reference from an expression
 * @param expression The expression inside ${...}
 * @returns Parsed variable reference
 */
export function parseVariableReference(expression: string): VariableReference {
  const trimmed = expression.trim();
  const segments = trimmed.split('.');
  const [type, ...path] = segments;

  let refType: VariableReference['type'] = 'unknown';
  if (type === 'inputs') refType = 'inputs';
  else if (type === 'steps') refType = 'steps';
  else if (type === 'env') refType = 'env';
  else if (['success', 'failure', 'always'].includes(type ?? '')) {
    refType = 'function';
  }

  return {
    expression: trimmed,
    type: refType,
    path,
  };
}

/**
 * Resolve a variable reference in the given context
 * @param ref The variable reference to resolve
 * @param context The interpolation context
 * @returns The resolved value
 */
export function resolveVariableReference(
  ref: VariableReference,
  context: InterpolationContext
): unknown {
  switch (ref.type) {
    case 'inputs':
      return resolvePath(context.inputs, ref.path);

    case 'steps': {
      const [stepId, ...fieldPath] = ref.path;
      if (!stepId) return undefined;

      const output = context.steps[stepId];
      if (!output) return undefined;

      // If no field path, return the entire output
      if (fieldPath.length === 0) {
        return output.parsed ?? output.raw;
      }

      // Handle 'output' prefix (${steps.stepId.output.field})
      if (fieldPath[0] === 'output') {
        const outputPath = fieldPath.slice(1);
        if (outputPath.length === 0) {
          return output.parsed ?? output.raw;
        }
        // Resolve path in parsed output
        if (output.parsed !== null && typeof output.parsed === 'object') {
          return resolvePath(output.parsed as Record<string, unknown>, outputPath);
        }
        return undefined;
      }

      // Direct field access
      if (fieldPath[0] === 'raw') return output.raw;
      if (fieldPath[0] === 'exitCode') return output.exitCode;
      if (fieldPath[0] === 'completedAt') return output.completedAt;
      if (fieldPath[0] === 'parsed') {
        const parsedPath = fieldPath.slice(1);
        if (parsedPath.length === 0) return output.parsed;
        if (output.parsed !== null && typeof output.parsed === 'object') {
          return resolvePath(output.parsed as Record<string, unknown>, parsedPath);
        }
        return undefined;
      }

      // Try to resolve in parsed output
      if (output.parsed !== null && typeof output.parsed === 'object') {
        return resolvePath(output.parsed as Record<string, unknown>, fieldPath);
      }

      return undefined;
    }

    case 'env':
      return ref.path.length > 0 ? context.env[ref.path[0]!] : undefined;

    case 'function': {
      const funcName = ref.expression.replace('()', '').trim();
      if (funcName === 'success') return context.functions.success();
      if (funcName === 'failure') return context.functions.failure();
      if (funcName === 'always') return context.functions.always();
      return undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Helper to resolve a path in a nested object
 */
function resolvePath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    // Handle array indexing (e.g., 'items[0]')
    const arrayMatch = segment.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, indexStr] = arrayMatch;
      if (typeof current !== 'object') return undefined;
      const arr = (current as Record<string, unknown>)[key!];
      if (!Array.isArray(arr)) return undefined;
      const index = parseInt(indexStr!, 10);
      current = arr[index];
      continue;
    }

    // Handle numeric index for arrays
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = parseInt(segment, 10);
      current = current[index];
      continue;
    }

    // Handle object property access
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Resolve a path safely, returning undefined for any errors
 */
export function resolvePathSafe(obj: unknown, path: string): unknown {
  try {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj !== 'object') return undefined;
    return resolvePath(obj as Record<string, unknown>, path.split('.'));
  } catch {
    return undefined;
  }
}

/**
 * Convert a value to string for interpolation
 */
function valueToString(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Interpolate variables in a template string
 * @param template The template string with ${...} patterns
 * @param context The interpolation context
 * @param options Interpolation options
 * @returns The interpolated string
 * @throws Error if strict mode and variable not found
 */
export function interpolate(
  template: string,
  context: InterpolationContext,
  options: InterpolateOptions = {}
): string {
  const { strict = false, defaultValue = '', coerceToString = true } = options;

  return template.replace(VARIABLE_PATTERN, (match, expression: string) => {
    const ref = parseVariableReference(expression);
    const value = resolveVariableReference(ref, context);

    if (value === undefined) {
      if (strict) {
        throw new Error(`Unresolved variable: ${expression}`);
      }
      return defaultValue;
    }

    if (coerceToString) {
      return valueToString(value);
    }

    // For non-string coercion, only return if already a string
    if (typeof value === 'string') {
      return value;
    }

    // Return the original match if can't coerce
    return match;
  });
}

/**
 * Interpolate a value that may be a string, object, or array
 * Recursively processes all string values
 * @param value The value to interpolate
 * @param context The interpolation context
 * @param options Interpolation options
 * @returns The interpolated value
 */
export function interpolateValue(
  value: unknown,
  context: InterpolationContext,
  options: InterpolateOptions = {}
): unknown {
  if (typeof value === 'string') {
    return interpolate(value, context, options);
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateValue(item, context, options));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateValue(val, context, options);
    }
    return result;
  }

  // Return primitives as-is
  return value;
}

/**
 * Extract all variable references from a template
 * @param template The template string
 * @returns Array of variable references found
 */
export function extractVariableReferences(template: string): VariableReference[] {
  const refs: VariableReference[] = [];
  let match;

  while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
    refs.push(parseVariableReference(match[1]!));
  }

  // Reset lastIndex for subsequent calls
  VARIABLE_PATTERN.lastIndex = 0;

  return refs;
}

/**
 * Check if a template contains any variable references
 * @param template The template string
 * @returns true if template contains ${...} patterns
 */
export function hasVariables(template: string): boolean {
  VARIABLE_PATTERN.lastIndex = 0;
  const result = VARIABLE_PATTERN.test(template);
  VARIABLE_PATTERN.lastIndex = 0;
  return result;
}

// Re-export context
export { ExecutionContext, type InterpolationContext } from './context.js';
