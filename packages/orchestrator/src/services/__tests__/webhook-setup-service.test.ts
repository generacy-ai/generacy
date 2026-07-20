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
    // Reset mocks and any queued mockResolvedValueOnce implementations before
    // each test. `clearAllMocks` clears call history but leaves the
    // implementation queue intact — under #972 several tests consume only 1
    // gh call where they previously consumed 2 (list failure now returns
    // early), so the leftover queued response would pollute the next test.
    vi.clearAllMocks();
    (workflowEngine.executeCommand as Mock).mockReset();

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
      expect(executeCommandMock).toHaveBeenCalledWith(
        'gh',
        ['api', '/repos/testorg/testrepo/hooks'],
        expect.anything(),
      );
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
      // Arrange — #972: list-403 immediately fails (row 1 of the decision
      // matrix); no create attempt. Only one gh mock consumed.
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'gh: Forbidden (HTTP 403)',
      });

      // Act
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert — #972 fail-loud message, not the pre-fix
      // "Insufficient permissions" line.
      expect(result.total).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testorg',
          repo: 'testrepo',
          missingScope: 'admin:repo_hook',
          reason: 'webhook-registration-forbidden',
        }),
        'Webhook registration forbidden: missing admin:repo_hook scope',
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
        ]),
        expect.anything(),
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
      // Arrange — #972: list failure returns early (rows 1-3), so repo1
      // consumes exactly one mock (list) then fails; repo2 consumes list
      // (empty) + create.
      executeCommandMock
        // Repo 1: list fails
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
    it('should take-over single smee.io hook with trailing-slash URL (#1005 FR-005)', async () => {
      // Arrange — pre-existing smee.io hook whose URL differs from ours only
      // by a trailing slash. Under #1005 this is a stale Generacy smee hook
      // (exactly one, prefix-match on https://smee.io/) → take-over branch
      // PATCHes it to the current URL rather than log-and-skipping.
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
          stdout: JSON.stringify({ id: 123 }),
          stderr: '',
        });

      // Act - URL without trailing slash
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert — take-over branch fires: repointed, not skipped.
      expect(result.total).toBe(1);
      expect(result.created).toBe(0);
      expect(result.reactivated).toBe(1);
      const patchCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('PATCH');
      });
      expect(patchCall).toBeDefined();
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

    it('should take-over single smee.io hook with query-param URL (#1005 FR-005)', async () => {
      // Arrange — pre-existing smee.io hook whose URL differs from ours by
      // a query string. Under #1005 this is a stale Generacy smee hook →
      // take-over branch PATCHes it, does NOT create a duplicate.
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
          stdout: JSON.stringify({ id: 123 }),
          stderr: '',
        });

      // Act - URL without query param
      const result = await service.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert — take-over branch fires: repointed, not skipped, no duplicate created.
      expect(result.total).toBe(1);
      expect(result.created).toBe(0);
      expect(result.reactivated).toBe(1);
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
        ]),
        expect.anything(),
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
      expect(executeCommandMock).toHaveBeenCalledWith(
        'gh',
        [
          'api',
          '-X', 'PATCH',
          '/repos/testorg/testrepo/hooks/456',
          '-F',
          'active=true',
          '-F',
          'events[]=push',
          '-F',
          'events[]=issues',
        ],
        expect.anything(),
      );
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

  // #972: fail-loud triple on webhook-registration 403 + FR-004 persisted-URL
  // stale-channel healing + FR-001 locked events on create. Contracts:
  // specs/972-summary-snappoll-preview/contracts/ensure-webhooks-behavior.md
  // specs/972-summary-snappoll-preview/contracts/webhook-registration-forbidden-event.md
  // specs/972-summary-snappoll-preview/contracts/degraded-status-transition.md
  describe('#972 fail-loud + persisted-URL healing', () => {
    let sendRelayEvent: Mock;
    let pushStatus: Mock;
    let readChannelFile: Mock;
    let readFileMock: Mock;

    beforeEach(() => {
      sendRelayEvent = vi.fn();
      pushStatus = vi.fn().mockResolvedValue(undefined);
      readChannelFile = vi.fn();
      readFileMock = readChannelFile;
    });

    /**
     * Build a service instance wired with the #972 DI hooks and a fake
     * `readFile` that returns the given persisted-URL string (or `null` /
     * throws for ENOENT). Kept local to this block so pre-existing tests
     * keep the pre-#972 constructor signature.
     */
    const buildService = (persistedUrl: string | null): WebhookSetupService => {
      // Route the persisted-URL file read through a temp path that our mock
      // resolves — the service uses `fs.readFile(channelFilePath)`, so we
      // point `channelFilePath` at a sentinel we intercept via the fake path.
      const channelFilePath = '/tmp/972-test-smee-channel-nonexistent';
      readChannelFile.mockImplementation(async () => {
        if (persistedUrl === null) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return persistedUrl;
      });
      // Patch `fs.readFile` for this instance by wrapping construction —
      // simplest path: stub node:fs/promises via vi.doMock. The service's
      // fallback is safe (returns null on any read error), so we can just
      // rely on ENOENT for the "no persisted URL" case and use a real temp
      // file for the persisted-URL case. To keep tests hermetic and avoid
      // filesystem side-effects, we spy on fs/promises below.
      return new WebhookSetupService(mockLogger, undefined, {
        sendRelayEvent,
        statusReporter: { pushStatus },
        channelFilePath,
        installationIdProvider: async () => 113597939,
      });
    };

    // Silence the unused-var warning by referencing the mock (each case that
    // needs to control persisted-URL will re-mock `fs.readFile` directly).
    void readFileMock;

    /** Wait for the fail-loud triple's async chain to flush. */
    const flushMicrotasks = async (): Promise<void> => {
      // Two ticks: the installationId provider promise + the pushStatus/send
      // fire-and-forget promises.
      await Promise.resolve();
      await Promise.resolve();
    };

    it('#972 case 1: 403 on list emits log + relay event + degraded status', async () => {
      // Arrange
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'gh: Resource not accessible by integration (HTTP 403)',
      });
      const svc = buildService(null);

      // Act
      const result = await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'christrudelpw', repo: 'snappoll' },
      ]);
      await flushMicrotasks();

      // Assert — return shape
      expect(result.failed).toBe(1);
      expect(result.results[0]).toEqual({
        owner: 'christrudelpw',
        repo: 'snappoll',
        action: 'failed',
        error: 'webhook-registration-forbidden',
      });

      // Assert — log line (audit floor)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'christrudelpw',
          repo: 'snappoll',
          installationId: 113597939,
          missingScope: 'admin:repo_hook',
          reason: 'webhook-registration-forbidden',
        }),
        'Webhook registration forbidden: missing admin:repo_hook scope',
      );

      // Assert — relay event on cluster.bootstrap
      expect(sendRelayEvent).toHaveBeenCalledTimes(1);
      expect(sendRelayEvent).toHaveBeenCalledWith('cluster.bootstrap', {
        status: 'failed',
        reason: 'webhook-registration-forbidden',
        repo: 'christrudelpw/snappoll',
        installationId: 113597939,
        missingScope: 'admin:repo_hook',
      });

      // Assert — degraded status transition
      expect(pushStatus).toHaveBeenCalledTimes(1);
      expect(pushStatus).toHaveBeenCalledWith(
        'degraded',
        'webhook-registration-forbidden',
      );
    });

    it('#972 case 2: 403 on create emits the same triple', async () => {
      // Arrange — list succeeds (empty), create fails 403.
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'HTTP 403: Resource not accessible by integration',
        });
      const svc = buildService(null);

      // Act
      const result = await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);
      await flushMicrotasks();

      // Assert
      expect(result.failed).toBe(1);
      expect(sendRelayEvent).toHaveBeenCalledWith(
        'cluster.bootstrap',
        expect.objectContaining({
          reason: 'webhook-registration-forbidden',
          repo: 'testorg/testrepo',
        }),
      );
      expect(pushStatus).toHaveBeenCalledWith(
        'degraded',
        'webhook-registration-forbidden',
      );
    });

    it('#972 case 3: 200 on create emits no relay event and no status change (regression)', async () => {
      // Arrange — list empty, create succeeds.
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 42 }),
          stderr: '',
        });
      const svc = buildService(null);

      // Act
      const result = await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);
      await flushMicrotasks();

      // Assert — happy path emits neither observable.
      expect(result.created).toBe(1);
      expect(sendRelayEvent).not.toHaveBeenCalled();
      expect(pushStatus).not.toHaveBeenCalled();
    });

    it('#972 case 4: existing hook with current-URL match is skipped (row 4)', async () => {
      // Arrange
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 999,
          active: true,
          config: { url: 'https://smee.io/abc123' },
          events: ['issues', 'pull_request', 'check_run', 'check_suite'],
        },
      ];
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(mockWebhooks),
        stderr: '',
      });
      const svc = buildService(null);

      // Act
      const result = await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.reactivated).toBe(0);
      // Only one gh call (list); no PATCH, no POST.
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
    });

    it('#972 case 5: persisted-URL match PATCHes to current URL + locked events (row 6)', async () => {
      // Arrange — write the stale prior channel URL to a real temp file so
      // the service's `fs.readFile(channelFilePath)` can resolve it. ESM
      // module exports can't be spied on, so we use a real file — hermetic
      // via os.tmpdir + unique filename + finally-cleanup.
      const persistedUrl = 'https://smee.io/stale-channel-xyz';
      const currentUrl = 'https://smee.io/new-channel-abc';
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const channelFilePath = path.join(
        os.tmpdir(),
        `972-test-channel-${process.pid}-${Date.now()}`,
      );
      await fs.writeFile(channelFilePath, persistedUrl + '\n');

      try {
        const mockWebhooks: GitHubWebhook[] = [
          {
            id: 777,
            active: true,
            config: { url: persistedUrl },
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
            stdout: JSON.stringify({ id: 777 }),
            stderr: '',
          });

        const svc = new WebhookSetupService(mockLogger, undefined, {
          sendRelayEvent,
          statusReporter: { pushStatus },
          channelFilePath,
          installationIdProvider: async () => 113597939,
        });

        // Act
        const result = await svc.ensureWebhooks(currentUrl, [
          { owner: 'testorg', repo: 'testrepo' },
        ]);

        // Assert — reactivated (URL healed).
        expect(result.reactivated).toBe(1);
        expect(result.results[0]?.webhookId).toBe(777);
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            oldUrl: persistedUrl,
            newUrl: currentUrl,
            events: ['issues', 'pull_request', 'check_run', 'check_suite'],
          }),
          'Updated Generacy webhook to current channel URL',
        );

        // Assert — PATCH call carries new URL + all four locked events.
        const patchCall = executeCommandMock.mock.calls.find((call) => {
          const args = call[1] as string[];
          return args.includes('PATCH');
        });
        expect(patchCall).toBeDefined();
        const patchArgs = patchCall![1] as string[];
        expect(patchArgs).toContain(`config[url]=${currentUrl}`);
        expect(patchArgs).toContain('events[]=issues');
        expect(patchArgs).toContain('events[]=pull_request');
        expect(patchArgs).toContain('events[]=check_run');
        expect(patchArgs).toContain('events[]=check_suite');
      } finally {
        await fs.rm(channelFilePath, { force: true });
      }
    });

    it('#972 case 6 / #1005 FR-005: exactly one stale smee hook is take-over-repointed (was: log-and-skipped)', async () => {
      // Arrange — hook URL matches neither current nor persisted (null).
      // Pre-#1005 this hit the foreign log-and-skip branch. Under #1005 the
      // single-hook take-over branch fires first and PATCHes the hook to the
      // current channel URL. The ≥2-hook case still lands on foreign.
      const mockWebhooks: GitHubWebhook[] = [
        {
          id: 555,
          active: true,
          config: { url: 'https://smee.io/some-other-project' },
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
          stdout: JSON.stringify({ id: 555 }),
          stderr: '',
        });
      const svc = buildService(null);

      // Act
      const result = await svc.ensureWebhooks('https://smee.io/current-channel', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert — take-over repointed the hook. No foreign warn.
      expect(result.reactivated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.created).toBe(0);
      const patchCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('PATCH');
      });
      expect(patchCall).toBeDefined();
      const foreignWarn = mockLogger.warn.mock.calls.find(
        (c) => c[1] === 'Foreign webhook present; not modifying',
      );
      expect(foreignWarn).toBeUndefined();
    });

    it('#972 case 7: create-time payload includes all four locked events', async () => {
      // Arrange — list empty triggers create.
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
        });
      const svc = buildService(null);

      // Act
      await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Assert — the POST call's argv includes all four spec-locked events.
      const createCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('POST');
      });
      expect(createCall).toBeDefined();
      const createArgs = createCall![1] as string[];
      expect(createArgs).toContain('events[]=issues');
      expect(createArgs).toContain('events[]=pull_request');
      expect(createArgs).toContain('events[]=check_run');
      expect(createArgs).toContain('events[]=check_suite');
      expect(createArgs).toContain('config[url]=https://smee.io/abc123');
      expect(createArgs).toContain('config[content_type]=json');
      expect(createArgs).toContain('active=true');
    });

    it('#972: 403 fires the triple at most once per (repo, boot)', async () => {
      // Arrange — two repos both hit 403 on list; only ONE relay event
      // per repo (bounded emission). Then re-run against the same repo —
      // no additional event.
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'HTTP 403',
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'HTTP 403',
        });
      const svc = buildService(null);

      // Act — one call, two repos
      await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);
      await flushMicrotasks();

      // Assert — 2 events, one per repo.
      expect(sendRelayEvent).toHaveBeenCalledTimes(2);

      // Act — re-run against repo1 alone; no NEW event.
      sendRelayEvent.mockClear();
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 403',
      });
      await svc.ensureWebhooks('https://smee.io/abc123', [
        { owner: 'org1', repo: 'repo1' },
      ]);
      await flushMicrotasks();

      // Assert — same-boot dedup: no new event for repo1.
      expect(sendRelayEvent).not.toHaveBeenCalled();
    });
  });

  // #1005: Adopt tier's discovery callback + single-hook take-over branch.
  // See specs/1005-summary-when-cluster-deleted/contracts/{find-existing-smee-channel,webhook-setup-takeover}.md
  describe('#1005 findExistingSmeeChannel', () => {
    it('T-find-1: single repo with one smee.io hook → returns that URL', async () => {
      const hooks: GitHubWebhook[] = [
        {
          id: 100,
          active: true,
          config: { url: 'https://smee.io/foundURL' },
          events: ['issues'],
        },
      ];
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(hooks),
        stderr: '',
      });

      const result = await service.findExistingSmeeChannel([
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      expect(result).toBe('https://smee.io/foundURL');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('T-find-2: single repo with no smee.io hooks → returns null', async () => {
      const hooks: GitHubWebhook[] = [
        {
          id: 200,
          active: true,
          config: { url: 'https://operator.example.com/webhook' },
          events: ['issues'],
        },
      ];
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(hooks),
        stderr: '',
      });

      const result = await service.findExistingSmeeChannel([
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      expect(result).toBeNull();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('T-find-3: two repos both returning the same smee URL → returns URL, no divergence warn', async () => {
      const sharedUrl = 'https://smee.io/sharedURL';
      const hooks1: GitHubWebhook[] = [
        { id: 300, active: true, config: { url: sharedUrl }, events: ['issues'] },
      ];
      const hooks2: GitHubWebhook[] = [
        { id: 301, active: true, config: { url: sharedUrl }, events: ['issues'] },
      ];
      executeCommandMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(hooks1), stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(hooks2), stderr: '' });

      const result = await service.findExistingSmeeChannel([
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);

      expect(result).toBe(sharedUrl);
      // No divergence warn — URLs matched.
      const divergenceWarn = mockLogger.warn.mock.calls.find(
        (c) =>
          c[1] ===
          'Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal',
      );
      expect(divergenceWarn).toBeUndefined();
    });

    it('T-find-4 (FR-004): two repos with different smee URLs → first-repo URL wins + one divergence warn', async () => {
      const firstUrl = 'https://smee.io/firstWINS';
      const secondUrl = 'https://smee.io/secondLOSES';
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: 400, active: true, config: { url: firstUrl }, events: ['issues'] },
          ]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: 401, active: true, config: { url: secondUrl }, events: ['issues'] },
          ]),
          stderr: '',
        });

      const result = await service.findExistingSmeeChannel([
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);

      expect(result).toBe(firstUrl);
      const divergenceWarns = mockLogger.warn.mock.calls.filter(
        (c) =>
          c[1] ===
          'Repo Generacy smee channel disagrees with first-repo winner — deferring to take-over on next self-heal',
      );
      expect(divergenceWarns).toHaveLength(1);
      const [ctx] = divergenceWarns[0] as [Record<string, unknown>, string];
      expect(ctx.chosenRepo).toBe('org1/repo1');
      expect(ctx.chosenUrl).toBe(firstUrl);
      expect(ctx.divergentRepo).toBe('org2/repo2');
      expect(ctx.divergentUrl).toBe(secondUrl);
    });

    it('T-find-5: first repo _listRepoWebhooks throws, second returns smee hook → returns second URL, one warn', async () => {
      const secondUrl = 'https://smee.io/RECOVERED';
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'HTTP 500: transient GitHub failure',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([
            { id: 500, active: true, config: { url: secondUrl }, events: ['issues'] },
          ]),
          stderr: '',
        });

      const result = await service.findExistingSmeeChannel([
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);

      expect(result).toBe(secondUrl);
      const skipWarn = mockLogger.warn.mock.calls.find(
        (c) =>
          c[1] ===
          'Failed to list webhooks during smee channel discovery — skipping repo',
      );
      expect(skipWarn).toBeDefined();
      const [ctx] = skipWarn as [Record<string, unknown>, string];
      expect(ctx.owner).toBe('org1');
      expect(ctx.repo).toBe('repo1');
    });
  });

  describe('#1005 take-over branch (_selectExistingHookForUpdate)', () => {
    /** Build a service configured with a nonexistent persisted-URL file so
     * `_readPersistedChannelUrl` returns null. */
    const buildNoPersistedService = (): WebhookSetupService =>
      new WebhookSetupService(mockLogger, undefined, {
        channelFilePath: '/tmp/1005-test-nonexistent',
      });

    it('T-takeover-1 (FR-005): exactly one stale Generacy smee hook → update-url fires', async () => {
      const currentUrl = 'https://smee.io/currentCHAN';
      const staleUrl = 'https://smee.io/staleORPHAN';
      const staleHooks: GitHubWebhook[] = [
        { id: 700, active: true, config: { url: staleUrl }, events: ['issues'] },
      ];
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(staleHooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 700 }),
          stderr: '',
        });

      const svc = buildNoPersistedService();
      const result = await svc.ensureWebhooks(currentUrl, [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      expect(result.reactivated).toBe(1);
      expect(result.results[0]).toEqual({
        owner: 'testorg',
        repo: 'testrepo',
        action: 'reactivated',
        webhookId: 700,
      });
      // Assert PATCH sent the current URL.
      const patchCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('PATCH');
      });
      expect(patchCall).toBeDefined();
      const patchArgs = patchCall![1] as string[];
      expect(patchArgs).toContain(`config[url]=${currentUrl}`);
    });

    it('T-takeover-2 (SC-004): two stale Generacy smee hooks → no update-url, existing foreign log-and-skip', async () => {
      const currentUrl = 'https://smee.io/currentCHAN';
      const staleA = 'https://smee.io/staleA';
      const staleB = 'https://smee.io/staleB';
      const staleHooks: GitHubWebhook[] = [
        { id: 800, active: true, config: { url: staleA }, events: ['issues'] },
        { id: 801, active: true, config: { url: staleB }, events: ['issues'] },
      ];
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(staleHooks),
        stderr: '',
      });

      const svc = buildNoPersistedService();
      const result = await svc.ensureWebhooks(currentUrl, [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Skipped (via foreign branch), no PATCH.
      expect(result.skipped).toBe(1);
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
      const foreignWarn = mockLogger.warn.mock.calls.find(
        (c) => c[1] === 'Foreign webhook present; not modifying',
      );
      expect(foreignWarn).toBeDefined();
    });

    it('T-takeover-3: zero Generacy smee hooks → create path fires', async () => {
      const currentUrl = 'https://smee.io/currentCHAN';
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 900 }),
          stderr: '',
        });

      const svc = buildNoPersistedService();
      const result = await svc.ensureWebhooks(currentUrl, [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      expect(result.created).toBe(1);
      const postCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('POST');
      });
      expect(postCall).toBeDefined();
    });

    it('T-takeover-4 (regression guard): after adopt, surviving hook URL === current → skip-active, no re-fire', async () => {
      const currentUrl = 'https://smee.io/adoptedFROMboot';
      // Post-adopt state: the surviving hook now matches the current channel.
      const hooks: GitHubWebhook[] = [
        { id: 1000, active: true, config: { url: currentUrl }, events: ['issues', 'pull_request', 'check_run', 'check_suite'] },
      ];
      executeCommandMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(hooks),
        stderr: '',
      });

      const svc = buildNoPersistedService();
      const result = await svc.ensureWebhooks(currentUrl, [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      expect(result.skipped).toBe(1);
      // No PATCH — take-over branch not re-firing on the now-current hook.
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
    });

    it('T-us3-guard (FR-009): non-smee foreign hook → classified foreign, untouched', async () => {
      const currentUrl = 'https://smee.io/currentCHAN';
      const hooks: GitHubWebhook[] = [
        {
          id: 1100,
          active: true,
          config: { url: 'https://operator.example.com/webhook' },
          events: ['issues'],
        },
      ];
      executeCommandMock
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify(hooks),
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ id: 1101 }),
          stderr: '',
        });

      const svc = buildNoPersistedService();
      const result = await svc.ensureWebhooks(currentUrl, [
        { owner: 'testorg', repo: 'testrepo' },
      ]);

      // Non-smee foreign is not classified as foreign by _selectExistingHookForUpdate
      // (only smee.io hooks are); it falls through to the create path.
      // The operator's hook is untouched (no PATCH, no DELETE).
      expect(result.created).toBe(1);
      const patchCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('PATCH');
      });
      expect(patchCall).toBeUndefined();
      const deleteCall = executeCommandMock.mock.calls.find((call) => {
        const args = call[1] as string[];
        return args.includes('DELETE');
      });
      expect(deleteCall).toBeUndefined();
    });
  });
});
