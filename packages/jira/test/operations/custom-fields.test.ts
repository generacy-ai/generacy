import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomFieldOperations, createCustomFieldOperations } from '../../src/operations/custom-fields.js';
import { JiraClient } from '../../src/client.js';
import { JiraNotFoundError } from '../../src/utils/errors.js';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

const mockFields = [
  {
    id: 'summary',
    key: 'summary',
    name: 'Summary',
    schema: { type: 'string', system: 'summary' },
  },
  {
    id: 'customfield_10001',
    key: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    name: 'Story Points',
    description: 'Estimated story points',
    schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
  },
  {
    id: 'customfield_10002',
    key: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
    name: 'Priority Level',
    description: 'Custom priority',
    schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
  },
];

describe('CustomFieldOperations', () => {
  let mockClient: {
    v3: {
      issueFields: {
        getFields: ReturnType<typeof vi.fn>;
      };
      issues: {
        getIssue: ReturnType<typeof vi.fn>;
        editIssue: ReturnType<typeof vi.fn>;
      };
      issueCustomFieldOptions: {
        getOptionsForField: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: CustomFieldOperations;

  beforeEach(() => {
    mockClient = {
      v3: {
        issueFields: {
          getFields: vi.fn(),
        },
        issues: {
          getIssue: vi.fn(),
          editIssue: vi.fn(),
        },
        issueCustomFieldOptions: {
          getOptionsForField: vi.fn(),
        },
      },
    };
    operations = createCustomFieldOperations(mockClient as unknown as JiraClient);
  });

  describe('getAll', () => {
    it('should get all custom fields', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      const fields = await operations.getAll();

      expect(fields).toHaveLength(2); // Only customfield_* entries
      expect(fields[0]?.id).toBe('customfield_10001');
      expect(fields[0]?.name).toBe('Story Points');
      expect(fields[0]?.type).toBe('number');
    });
  });

  describe('get', () => {
    it('should get a custom field by ID', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      const field = await operations.get('customfield_10001');

      expect(field.id).toBe('customfield_10001');
      expect(field.name).toBe('Story Points');
    });

    it('should throw JiraNotFoundError for non-existent field', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      await expect(operations.get('customfield_99999')).rejects.toThrow(JiraNotFoundError);
    });
  });

  describe('getByName', () => {
    it('should get a custom field by name', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      const field = await operations.getByName('Story Points');

      expect(field.id).toBe('customfield_10001');
    });

    it('should match name case-insensitively', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      const field = await operations.getByName('story points');

      expect(field.id).toBe('customfield_10001');
    });

    it('should throw JiraNotFoundError for non-existent field name', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      await expect(operations.getByName('Non-existent Field')).rejects.toThrow(JiraNotFoundError);
    });
  });

  describe('getValue', () => {
    it('should get a custom field value for an issue', async () => {
      mockClient.v3.issues.getIssue.mockResolvedValue({
        fields: {
          customfield_10001: 5,
        },
      });

      const value = await operations.getValue('PROJ-123', 'customfield_10001');

      expect(mockClient.v3.issues.getIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: ['customfield_10001'],
      });
      expect(value).toBe(5);
    });
  });

  describe('setValue', () => {
    it('should set a custom field value with separate arguments', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);

      await operations.setValue('PROJ-123', 'customfield_10001', 8);

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          customfield_10001: 8,
        },
      });
    });

    it('should set a custom field value with params object', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);

      await operations.setValue({
        issueKey: 'PROJ-123',
        fieldId: 'customfield_10001',
        value: 13,
      });

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          customfield_10001: 13,
        },
      });
    });
  });

  describe('setMultiple', () => {
    it('should set multiple custom fields at once', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);

      await operations.setMultiple('PROJ-123', {
        customfield_10001: 5,
        customfield_10002: { id: '10000' },
      });

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          customfield_10001: 5,
          customfield_10002: { id: '10000' },
        },
      });
    });
  });

  describe('clear', () => {
    it('should clear a custom field value', async () => {
      mockClient.v3.issues.editIssue.mockResolvedValue(undefined);

      await operations.clear('PROJ-123', 'customfield_10001');

      expect(mockClient.v3.issues.editIssue).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        fields: {
          customfield_10001: null,
        },
      });
    });
  });

  describe('getOptions', () => {
    it('should return empty array for a select field', async () => {
      // getOptions calls getAll() first to find the field
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      const options = await operations.getOptions('customfield_10002');

      // Current simplified implementation returns empty array
      // Full implementation would query field options via additional API
      expect(options).toHaveLength(0);
    });

    it('should throw for non-existent field', async () => {
      mockClient.v3.issueFields.getFields.mockResolvedValue(mockFields);

      await expect(operations.getOptions('customfield_99999')).rejects.toThrow(JiraNotFoundError);
    });
  });
});
