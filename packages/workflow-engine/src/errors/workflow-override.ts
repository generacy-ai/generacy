/**
 * Thrown when a workflow has an invalid override configuration.
 * Examples: `overrides` without `extends`, or `phases` and `overrides.phases`
 * specified simultaneously.
 */
export class WorkflowOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOverrideError';
  }
}
