import type { JiraClient } from '../client.js';
import type {
  CustomField,
  CustomFieldType,
  CustomFieldOption,
  SetCustomFieldParams,
} from '../types/custom-fields.js';
import type { FieldSchema } from '../types/workflows.js';
import { ensureIssueKey } from '../utils/validation.js';
import { wrapJiraError, JiraNotFoundError } from '../utils/errors.js';

/**
 * Map field type string to CustomFieldType
 */
function mapFieldType(schema: FieldSchema): CustomFieldType {
  const typeMap: Record<string, CustomFieldType> = {
    string: 'string',
    number: 'number',
    date: 'date',
    datetime: 'datetime',
    user: 'user',
    option: 'select',
    array: 'array',
  };

  // Check for specific custom field types
  if (schema.custom) {
    if (schema.custom.includes('multiselect')) return 'multiselect';
    if (schema.custom.includes('select')) return 'select';
    if (schema.custom.includes('cascadingselect')) return 'cascadingselect';
    if (schema.custom.includes('labels')) return 'labels';
    if (schema.custom.includes('userpicker')) return 'user';
    if (schema.custom.includes('datepicker')) return 'date';
    if (schema.custom.includes('datetime')) return 'datetime';
  }

  return typeMap[schema.type] ?? 'string';
}

/**
 * Map API response to CustomField
 */
function mapCustomField(raw: Record<string, unknown>): CustomField {
  const schema = raw.schema as FieldSchema;
  return {
    id: raw.id as string,
    key: raw.key as string,
    name: raw.name as string,
    description: (raw.description as string) ?? null,
    type: mapFieldType(schema),
    schema,
  };
}

/**
 * Custom field operations
 */
export class CustomFieldOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Get all custom fields in the Jira instance
   */
  async getAll(): Promise<CustomField[]> {
    try {
      const response = await this.client.v3.issueFields.getFields();
      return response
        .filter((f) => (f.id as string).startsWith('customfield_'))
        .map((f) => mapCustomField(f as unknown as Record<string, unknown>));
    } catch (error) {
      throw wrapJiraError(error, 'Failed to get custom fields');
    }
  }

  /**
   * Get a specific custom field by ID
   */
  async get(fieldId: string): Promise<CustomField> {
    const fields = await this.getAll();
    const field = fields.find((f) => f.id === fieldId);

    if (!field) {
      throw new JiraNotFoundError('Custom field', fieldId);
    }

    return field;
  }

  /**
   * Get a custom field by name
   */
  async getByName(name: string): Promise<CustomField> {
    const fields = await this.getAll();
    const field = fields.find(
      (f) => f.name.toLowerCase() === name.toLowerCase()
    );

    if (!field) {
      throw new JiraNotFoundError('Custom field', name);
    }

    return field;
  }

  /**
   * Get the value of a custom field for an issue
   */
  async getValue(issueKey: string, fieldId: string): Promise<unknown> {
    const key = ensureIssueKey(issueKey);

    try {
      const response = await this.client.v3.issues.getIssue({
        issueIdOrKey: key,
        fields: [fieldId],
      });
      const fields = response.fields as Record<string, unknown>;
      return fields[fieldId];
    } catch (error) {
      throw wrapJiraError(error, `Failed to get custom field ${fieldId} for ${key}`);
    }
  }

  /**
   * Set the value of a custom field for an issue
   */
  async setValue(issueKey: string, fieldId: string, value: unknown): Promise<void>;
  async setValue(params: SetCustomFieldParams): Promise<void>;
  async setValue(
    issueKeyOrParams: string | SetCustomFieldParams,
    fieldId?: string,
    value?: unknown
  ): Promise<void> {
    let key: string;
    let field: string;
    let fieldValue: unknown;

    if (typeof issueKeyOrParams === 'string') {
      key = ensureIssueKey(issueKeyOrParams);
      field = fieldId!;
      fieldValue = value;
    } else {
      key = ensureIssueKey(issueKeyOrParams.issueKey);
      field = issueKeyOrParams.fieldId;
      fieldValue = issueKeyOrParams.value;
    }

    try {
      await this.client.v3.issues.editIssue({
        issueIdOrKey: key,
        fields: {
          [field]: fieldValue,
        },
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to set custom field ${field} for ${key}`);
    }
  }

  /**
   * Get options for a select/multiselect custom field
   * Note: This uses the issue field configuration API
   */
  async getOptions(fieldId: string): Promise<CustomFieldOption[]> {
    try {
      // Get the field configuration which includes options for select fields
      const fields = await this.getAll();
      const field = fields.find((f) => f.id === fieldId);

      if (!field) {
        throw new JiraNotFoundError('Custom field', fieldId);
      }

      // For select fields, we need to query the field options
      // This is a simplified implementation - full options require additional API calls
      return [];
    } catch (error) {
      throw wrapJiraError(error, `Failed to get options for custom field ${fieldId}`);
    }
  }

  /**
   * Set multiple custom fields at once
   */
  async setMultiple(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    const key = ensureIssueKey(issueKey);

    try {
      await this.client.v3.issues.editIssue({
        issueIdOrKey: key,
        fields,
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to set custom fields for ${key}`);
    }
  }

  /**
   * Clear a custom field value
   */
  async clear(issueKey: string, fieldId: string): Promise<void> {
    await this.setValue(issueKey, fieldId, null);
  }
}

/**
 * Create custom field operations instance
 */
export function createCustomFieldOperations(client: JiraClient): CustomFieldOperations {
  return new CustomFieldOperations(client);
}
