import type { FieldSchema } from './workflows.js';

/**
 * Custom field type identifiers
 */
export type CustomFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'datetime'
  | 'user'
  | 'select'
  | 'multiselect'
  | 'labels'
  | 'cascadingselect'
  | 'array';

/**
 * Custom field definition
 */
export interface CustomField {
  /** Field ID (e.g., "customfield_10001") */
  id: string;

  /** Field key (e.g., "com.atlassian.jira.plugin.system.customfieldtypes:textfield") */
  key: string;

  /** Human-readable name */
  name: string;

  /** Field description */
  description: string | null;

  /** Semantic type */
  type: CustomFieldType;

  /** Schema definition */
  schema: FieldSchema;
}

/**
 * Custom field option (for select fields)
 */
export interface CustomFieldOption {
  id: string;
  value: string;
  disabled?: boolean;
}

/**
 * Custom field context (where the field is available)
 */
export interface CustomFieldContext {
  id: string;
  name: string;
  projectIds?: string[];
  issueTypeIds?: string[];
}

/**
 * Parameters for setting a custom field value
 */
export interface SetCustomFieldParams {
  issueKey: string;
  fieldId: string;
  value: unknown;
}
