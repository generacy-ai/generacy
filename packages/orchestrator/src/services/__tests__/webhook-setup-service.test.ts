import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { WebhookSetupService } from '../webhook-setup-service.js';
import type { GitHubWebhook } from '../../types/webhook.js';
import * as workflowEngine from '@generacy-ai/workflow-engine';

// Mock the executeCommand function
vi.mock('@generacy-ai/workflow-engine', () => ({
  executeCommand: vi.fn(),
}));

describe('WebhookSetupService', () => {
  let service: WebhookSetupService;
  let mockLogger: {
    info: Mock;
    warn: Mock;
    error: Mock;
  };
  let executeCommandMock: Mock;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Create mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Get reference to mocked executeCommand
    executeCommandMock = workflowEngine.executeCommand as Mock;

    // Create service instance
    service = new WebhookSetupService(mockLogger);
  });

  describe('webhook listing', () => {
    it('should list webhooks for a repository successfully', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
        {
          id: 456,
          active: false,
          config: { url: 'https://example.com/webhook' },
          events: ['push', 'pull_request'],
        },
      ];

      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(executeCommandMock).toHaveBeenCalledWith('gh', [
        'api',
        'GET /repos/testorg/testrepo/hooks',
      ]);
      expect(result.total).toBe(1);
      expect(result.skipped).toBe(1); // Webhook already exists and is active
      expect(result.created).toBe(0);
    });

    it('should return empty array when listing webhooks fails', async () => {
      // Arrange
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'API rate limit exceeded',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          stderr: 'API rate limit exceeded',
        }),
        'Failed to list webhooks for repository'
      );
      // Should attempt to create webhook since listing failed
      expect(result.total).toBe(1);
    });

    it('should handle invalid JSON response gracefully', async () => {
      // Arrange
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'not valid json',
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
        }),
        'Error listing webhooks for repository'
      );
      // Should attempt to create webhook since listing failed
      expect(result.total).toBe(1);
    });

    it('should handle non-array JSON response gracefully', async () => {
      // Arrange
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ error: 'Not an array' }),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          response: JSON.stringify({ error: 'Not an array' }),
        }),
        'Unexpected response format when listing webhooks (expected array)'
      );
      // Should attempt to create webhook since listing returned invalid data
      expect(result.total).toBe(1);
    });

    it('should handle empty webhook list', async () => {
      // Arrange
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 789 }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.results[0]?.webhookId).toBe(789);
    });

    it('should match webhooks case-insensitively', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://SMEE.io/ABC123' }, // Different case
          events: ['issues'],
        },
      ];

      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.skipped).toBe(1); // Should match despite different case
      expect(result.created).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          webhookId: 123,
          action: 'skipped',
        }),
        'Webhook already exists and is active'
      );
    });

    it('should handle webhooks with missing config.url', async () => {
      // Arrange
      const mockWebhooks = [
        {
          id: 123,
          active: true,
          config: {}, // Missing url
          events: ['issues'],
        },
      ] as GitHubWebhook[];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.created).toBe(1); // Should create new webhook since existing one has no URL
      expect(result.skipped).toBe(0);
    });

    it('should process multiple repositories in sequence', async () => {
      // Arrange
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 100 }),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 200,
              active: true,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);

      // Assert
      expect(result.total).toBe(2);
      expect(result.created).toBe(1); // repo1
      expect(result.skipped).toBe(1); // repo2
      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.action).toBe('created');
      expect(result.results[1]?.action).toBe('skipped');
    });

    it('should handle 403 permission errors gracefully', async () => {
      // Arrange - list fails, then create also fails
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Forbidden (HTTP 403)',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Forbidden (HTTP 403)',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
        }),
        expect.stringContaining('Insufficient permissions')
      );
    });

    it('should handle 404 not found errors gracefully', async () => {
      // Arrange - list fails, then create also fails
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Not Found (HTTP 404)',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Not Found (HTTP 404)',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
        }),
        expect.stringContaining('Insufficient permissions')
      );
    });

    it('should warn on non-smee.io URLs', async () => {
      // Arrange
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123 }),
          stderr: '',
        });

      // Act
      await service.ensureWebhooks('https://example.com/webhook', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          smeeChannelUrl: 'https://example.com/webhook',
        }),
        expect.stringContaining('does not point to smee.io')
      );
    });

    it('should reactivate inactive webhooks and merge events', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false, // Inactive
          config: { url: 'https://smee.io/abc123' },
          events: ['push'], // Missing 'issues'
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(executeCommandMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining([
          'api',
          'PATCH',
          '/repos/testorg/testrepo/hooks/123',
        ])
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          webhookId: 123,
          events: ['push', 'issues'], // Merged events
        }),
        'Reactivated inactive webhook'
      );
    });

    it('should warn when active webhook has event mismatch', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://smee.io/abc123' },
          events: ['push', 'pull_request'], // Missing 'issues'
        },
      ];

      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.skipped).toBe(1); // Still skipped, not modified
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          webhookId: 123,
          currentEvents: ['push', 'pull_request'],
          expectedEvents: ['issues'],
        }),
        'Existing webhook has event mismatch - events not updated'
      );
    });

    it('should handle webhook creation failure', async () => {
      // Arrange
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Validation failed: hook already exists',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.created).toBe(0);
      expect(result.results[0]?.error).toContain('Failed to create webhook');
    });

    it('should handle webhook update failure', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Not Found',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.reactivated).toBe(0);
      expect(result.results[0]?.error).toContain('Failed to update webhook');
    });

    it('should continue processing other repos if one fails', async () => {
      // Arrange
      executeCommandMock
        // Repo 1: list fails, then create fails
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'API error',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'API error',
        })
        // Repo 2: list succeeds (empty), then create succeeds
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);

      // Assert
      expect(result.total).toBe(2);
      expect(result.failed).toBe(1); // repo1
      expect(result.created).toBe(1); // repo2
      expect(result.results[0]?.action).toBe('failed');
      expect(result.results[1]?.action).toBe('created');
    });

    it('should handle 500 GitHub API errors with appropriate logging', async () => {
      // Arrange - list fails, then create also fails
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Internal Server Error (HTTP 500)',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Internal Server Error (HTTP 500)',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
        }),
        'GitHub API error while managing webhooks'
      );
    });
  });

  describe('webhook matching', () => {
    it('should not match webhooks with trailing slashes in URLs', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://smee.io/abc123/' }, // Trailing slash
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act - URL without trailing slash
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should NOT match (no URL normalization beyond case)
      expect(result.total).toBe(1);
      expect(result.created).toBe(1); // Creates new because URLs don't exactly match
      expect(result.skipped).toBe(0);
    });

    it('should not match webhooks with different protocols', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'http://smee.io/abc123' }, // http instead of https
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act - https URL
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should NOT match (different protocol)
      expect(result.total).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should match webhooks with mixed case domains', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://Smee.IO/AbC123' }, // Mixed case
          events: ['issues'],
        },
      ];

      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should match (case-insensitive)
      expect(result.total).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          webhookId: 123,
          action: 'skipped',
        }),
        'Webhook already exists and is active'
      );
    });

    it('should handle webhooks with null or undefined config', async () => {
      // Arrange
      const mockWebhooks = [
        {
          id: 123,
          active: true,
          config: null, // Null config
          events: ['issues'],
        },
        {
          id: 456,
          active: true,
          // Missing config property entirely
          events: ['issues'],
        },
      ] as unknown as GitHubWebhook[];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 789 }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should not match and create new webhook
      expect(result.total).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should match exact URL including query parameters', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://smee.io/abc123?param=value' },
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act - URL without query param
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should NOT match (query params differ)
      expect(result.total).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should match first webhook when multiple webhooks point to same URL', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
        {
          id: 456,
          active: false,
          config: { url: 'https://smee.io/abc123' }, // Duplicate URL
          events: ['push'],
        },
      ];

      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should match first active webhook
      expect(result.total).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.results[0]?.webhookId).toBe(123); // First matching webhook
    });

    it('should handle webhooks with empty string URL', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: true,
          config: { url: '' }, // Empty string
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456 }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should not match and create new webhook
      expect(result.total).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should use first matching webhook (order matters)', async () => {
      // Arrange - first webhook is inactive, second is active (both match URL)
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
        {
          id: 456,
          active: true,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - Should match first webhook (inactive), so reactivate it
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.results[0]?.webhookId).toBe(123); // First match wins
    });
  });

  describe('webhook reactivation', () => {
    it('should reactivate inactive webhook without changing events when issues already included', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues', 'push'], // Already has issues
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(executeCommandMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining([
          'api',
          'PATCH',
          '/repos/testorg/testrepo/hooks/123',
        ])
      );
      // Events should be deduplicated (issues + push)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          events: expect.arrayContaining(['issues', 'push']),
        }),
        'Reactivated inactive webhook'
      );
    });

    it('should reactivate inactive webhook and add issues event when missing', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['push', 'pull_request'], // Missing issues
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          events: expect.arrayContaining(['push', 'pull_request', 'issues']),
        }),
        'Reactivated inactive webhook'
      );
    });

    it('should reactivate inactive webhook with empty events array', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: [], // No events configured
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          events: ['issues'], // Should add issues event
        }),
        'Reactivated inactive webhook'
      );
    });

    it('should build correct PATCH request with active flag and merged events', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 456,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['push'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 456, active: true }),
          stderr: '',
        });

      // Act
      await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - verify the exact PATCH command structure
      expect(executeCommandMock).toHaveBeenCalledWith('gh', [
        'api',
        'PATCH',
        '/repos/testorg/testrepo/hooks/456',
        '-F',
        'active=true',
        '-F',
        'events[]=push',
        '-F',
        'events[]=issues',
      ]);
    });

    it('should handle reactivation with duplicate events correctly', async () => {
      // Arrange - webhook has issues twice for some reason
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues', 'push', 'issues'], // Duplicates
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - events should be deduplicated
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          // Should only have unique events
          events: expect.arrayContaining(['issues', 'push']),
        }),
        'Reactivated inactive webhook'
      );
      // Verify exactly 2 unique events (not 3)
      const logCall = mockLogger.info.mock.calls.find((call) =>
        call[1]?.includes('Reactivated inactive webhook')
      );
      expect(logCall?.[0]?.events).toHaveLength(2);
    });

    it('should return failed status when reactivation PATCH fails', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Rate limit exceeded',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.reactivated).toBe(0);
      expect(result.results[0]?.action).toBe('failed');
      expect(result.results[0]?.error).toContain('Failed to update webhook');
    });

    it('should handle reactivation across multiple repos with mixed results', async () => {
      // Arrange
      executeCommandMock
        // Repo 1: needs reactivation (success)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 100,
              active: false,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 100, active: true }),
          stderr: '',
        })
        // Repo 2: needs reactivation (fails)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 200,
              active: false,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Permission denied',
        })
        // Repo 3: already active (skip)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 300,
              active: true,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
        { owner: 'org3', repo: 'repo3' },
      ]);

      // Assert
      expect(result.total).toBe(3);
      expect(result.reactivated).toBe(1); // repo1
      expect(result.failed).toBe(1); // repo2
      expect(result.skipped).toBe(1); // repo3
      expect(result.results[0]?.action).toBe('reactivated');
      expect(result.results[1]?.action).toBe('failed');
      expect(result.results[2]?.action).toBe('skipped');
    });

    it('should preserve order of events when reactivating with issues event', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['push', 'pull_request', 'release'],
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - all original events plus issues should be present
      const logCall = mockLogger.info.mock.calls.find((call) =>
        call[1]?.includes('Reactivated inactive webhook')
      );
      const events = logCall?.[0]?.events as string[];
      expect(events).toContain('push');
      expect(events).toContain('pull_request');
      expect(events).toContain('release');
      expect(events).toContain('issues');
      expect(events).toHaveLength(4);
    });

    it('should handle reactivation when webhook has only issues event', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 123,
          active: false,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues'], // Already has only issues
        },
      ];

      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(mockWebhooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 123, active: true }),
          stderr: '',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert - should still reactivate, events unchanged
      expect(result.total).toBe(1);
      expect(result.reactivated).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reactivated',
          events: ['issues'], // Same event, just reactivated
        }),
        'Reactivated inactive webhook'
      );
    });
  });

  describe('summary aggregation', () => {
    it('should correctly aggregate results across multiple operations', async () => {
      // Arrange - setup different scenarios for different repos
      executeCommandMock
        // Repo 1: needs creation
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 100 }),
          stderr: '',
        })
        // Repo 2: already exists
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 200,
              active: true,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        })
        // Repo 3: needs reactivation
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: 300,
              active: false,
              config: { url: 'https://smee.io/abc123' },
              events: ['issues'],
            },
          ]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 300, active: true }),
          stderr: '',
        })
        // Repo 4: fails
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Permission denied',
        });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
        { owner: 'org3', repo: 'repo3' },
        { owner: 'org4', repo: 'repo4' },
      ]);

      // Assert
      expect(result).toEqual({
        total: 4,
        created: 1,
        skipped: 1,
        reactivated: 1,
        failed: 1,
        results: expect.arrayContaining([
          expect.objectContaining({ owner: 'org1', action: 'created' }),
          expect.objectContaining({ owner: 'org2', action: 'skipped' }),
          expect.objectContaining({ owner: 'org3', action: 'reactivated' }),
          expect.objectContaining({ owner: 'org4', action: 'failed' }),
        ]),
      });
    });
  });
});
