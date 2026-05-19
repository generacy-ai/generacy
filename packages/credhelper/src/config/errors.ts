import type { ConfigError } from './types.js';

export class ConfigValidationError extends Error {
  readonly errors: ConfigError[];

  constructor(errors: ConfigError[]) {
    const summary = errors
      .map(
        (e) =>
          `  ${e.file}${e.field ? `:${e.field}` : ''}: ${e.message}`,
      )
      .join('\n');
    super(
      `Config validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${summary}`,
    );
    this.errors = errors;
    this.name = 'ConfigValidationError';
  }
}
