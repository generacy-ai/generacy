/**
 * Status category (groups statuses into logical categories)
 */
export interface StatusCategory {
  id: number;
  key: 'new' | 'indeterminate' | 'done';
  name: string;
  colorName: string;
}

/**
 * Jira status representation
 */
export interface JiraStatus {
  id: string;
  name: string;
  description: string | null;
  statusCategory: StatusCategory;
}

/**
 * Field schema for transition fields
 */
export interface FieldSchema {
  type: string;
  items?: string;
  custom?: string;
  customId?: number;
  system?: string;
}

/**
 * Field definition for transition screens
 */
export interface TransitionField {
  required: boolean;
  schema: FieldSchema;
  name: string;
  operations: string[];
  allowedValues?: unknown[];
}

/**
 * Workflow transition representation
 */
export interface Transition {
  id: string;
  name: string;
  to: JiraStatus;
  hasScreen: boolean;
  isGlobal: boolean;
  isInitial: boolean;
  isConditional: boolean;
  fields?: Record<string, TransitionField>;
}

/**
 * Parameters for executing a transition
 */
export interface TransitionParams {
  transitionId: string;
  fields?: Record<string, unknown>;
  comment?: string;
}
