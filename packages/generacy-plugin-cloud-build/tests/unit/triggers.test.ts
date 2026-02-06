/**
 * Unit tests for trigger operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerOperations } from '../../src/operations/triggers.js';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import type { CloudBuildConfig } from '../../src/config/types.js';
import type { TriggerConfig } from '../../src/types/triggers.js';
import type { Logger } from 'pino';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

// Mock config
const mockConfig: CloudBuildConfig = {
  projectId: 'test-project',
  location: 'global',
  retry: {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
  },
  logPollingIntervalMs: 2000,
};

// Mock trigger response
const mockTriggerResponse = {
  id: 'trigger-123',
  name: 'my-trigger',
  description: 'Test trigger',
  disabled: false,
  createTime: { seconds: 1704067200, nanos: 0 },
  tags: ['test'],
  github: {
    owner: 'test-owner',
    name: 'test-repo',
    push: {
      branch: 'main',
    },
  },
  filename: 'cloudbuild.yaml',
};

// Create mock client
const createMockClient = () => ({
  listBuildTriggers: vi.fn().mockResolvedValue([[mockTriggerResponse]]),
  createBuildTrigger: vi.fn().mockResolvedValue([mockTriggerResponse]),
  getBuildTrigger: vi.fn().mockResolvedValue([mockTriggerResponse]),
  updateBuildTrigger: vi.fn().mockResolvedValue([mockTriggerResponse]),
  deleteBuildTrigger: vi.fn().mockResolvedValue([{}]),
});

describe('TriggerOperations', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let triggerOps: TriggerOperations;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    triggerOps = new TriggerOperations(mockClient as any, mockConfig, mockLogger);
  });

  describe('listTriggers', () => {
    it('should list all triggers', async () => {
      const triggers = await triggerOps.listTriggers();

      expect(mockClient.listBuildTriggers).toHaveBeenCalledWith({
        projectId: 'test-project',
      });
      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.id).toBe('trigger-123');
      expect(triggers[0]?.name).toBe('my-trigger');
    });

    it('should map trigger fields correctly', async () => {
      const triggers = await triggerOps.listTriggers();
      const trigger = triggers[0];

      expect(trigger?.description).toBe('Test trigger');
      expect(trigger?.disabled).toBe(false);
      expect(trigger?.createTime).toBeInstanceOf(Date);
      expect(trigger?.tags).toEqual(['test']);
      expect(trigger?.github?.owner).toBe('test-owner');
      expect(trigger?.github?.push?.branch).toBe('main');
      expect(trigger?.filename).toBe('cloudbuild.yaml');
    });
  });

  describe('createTrigger', () => {
    const validConfig: TriggerConfig = {
      name: 'new-trigger',
      description: 'A new trigger',
      github: {
        owner: 'owner',
        name: 'repo',
        push: { branch: 'main' },
      },
      filename: 'cloudbuild.yaml',
    };

    it('should create a trigger with valid config', async () => {
      const result = await triggerOps.createTrigger(validConfig);

      expect(mockClient.createBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        trigger: expect.objectContaining({
          name: 'new-trigger',
          description: 'A new trigger',
        }),
      });
      expect(result.id).toBe('trigger-123');
    });

    it('should throw ValidationError for invalid trigger name', async () => {
      const invalidConfig: TriggerConfig = {
        ...validConfig,
        name: 'Invalid Name!',
      };

      await expect(triggerOps.createTrigger(invalidConfig))
        .rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when neither build nor filename provided', async () => {
      const invalidConfig: TriggerConfig = {
        name: 'valid-name',
        github: {
          owner: 'owner',
          name: 'repo',
          push: { branch: 'main' },
        },
      };

      await expect(triggerOps.createTrigger(invalidConfig))
        .rejects.toThrow(ValidationError);
    });

    it('should accept trigger with build config instead of filename', async () => {
      const buildConfig: TriggerConfig = {
        name: 'build-trigger',
        github: {
          owner: 'owner',
          name: 'repo',
          push: { branch: 'main' },
        },
        build: {
          steps: [{ name: 'node:20', args: ['install'] }],
        },
      };

      await triggerOps.createTrigger(buildConfig);

      expect(mockClient.createBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        trigger: expect.objectContaining({
          name: 'build-trigger',
          build: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ name: 'node:20' }),
            ]),
          }),
        }),
      });
    });
  });

  describe('updateTrigger', () => {
    it('should update an existing trigger', async () => {
      const updates: Partial<TriggerConfig> = {
        description: 'Updated description',
      };

      const result = await triggerOps.updateTrigger('trigger-123', updates);

      expect(mockClient.getBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        triggerId: 'trigger-123',
      });
      expect(mockClient.updateBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        triggerId: 'trigger-123',
        trigger: expect.objectContaining({
          id: 'trigger-123',
        }),
      });
      expect(result.id).toBe('trigger-123');
    });

    it('should throw NotFoundError when trigger not found', async () => {
      mockClient.getBuildTrigger.mockResolvedValue([null]);

      await expect(triggerOps.updateTrigger('nonexistent', {}))
        .rejects.toThrow(NotFoundError);
    });

    it('should validate name if provided in updates', async () => {
      await expect(triggerOps.updateTrigger('trigger-123', { name: 'INVALID!' }))
        .rejects.toThrow(ValidationError);
    });
  });

  describe('deleteTrigger', () => {
    it('should delete a trigger', async () => {
      await triggerOps.deleteTrigger('trigger-123');

      expect(mockClient.deleteBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        triggerId: 'trigger-123',
      });
    });
  });

  describe('trigger name validation', () => {
    const validNames = [
      'my-trigger',
      'trigger-123',
      'a',
      'abc',
      'a1b2c3',
    ];

    const invalidNames = [
      '123-trigger',  // Must start with letter
      'My-Trigger',   // No uppercase
      'my_trigger',   // No underscores
      'my trigger',   // No spaces
      '',             // Empty
    ];

    it.each(validNames)('should accept valid name: %s', async (name) => {
      const config: TriggerConfig = {
        name,
        filename: 'cloudbuild.yaml',
      };

      await triggerOps.createTrigger(config);

      expect(mockClient.createBuildTrigger).toHaveBeenCalled();
    });

    it.each(invalidNames)('should reject invalid name: %s', async (name) => {
      const config: TriggerConfig = {
        name,
        filename: 'cloudbuild.yaml',
      };

      await expect(triggerOps.createTrigger(config))
        .rejects.toThrow(ValidationError);
    });
  });
});
