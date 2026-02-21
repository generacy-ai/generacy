/**
 * Thrown when a base workflow referenced by `extends` cannot be found
 * in any of the searched locations.
 */
export class BaseWorkflowNotFoundError extends Error {
  public readonly workflowName: string;
  public readonly searchedLocations: string[];

  constructor(workflowName: string, searchedLocations: string[]) {
    const locations = searchedLocations.length > 0
      ? `\n  Searched:\n    - ${searchedLocations.join('\n    - ')}`
      : '';
    super(`Base workflow "${workflowName}" not found.${locations}`);
    this.name = 'BaseWorkflowNotFoundError';
    this.workflowName = workflowName;
    this.searchedLocations = searchedLocations;
  }
}
