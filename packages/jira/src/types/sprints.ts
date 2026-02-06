/**
 * Sprint state
 */
export type SprintState = 'active' | 'closed' | 'future';

/**
 * Sprint representation
 */
export interface Sprint {
  id: number;
  self: string;
  state: SprintState;
  name: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  originBoardId: number;
  goal: string | null;
}

/**
 * Parameters for adding an issue to a sprint
 */
export interface AddToSprintParams {
  issueKey: string;
  sprintId: number;
}
