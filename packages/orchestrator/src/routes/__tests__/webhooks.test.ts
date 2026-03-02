/**
 * Unit tests for label webhook route (POST /webhooks/github)
 *
 * T015: [US1] Extend webhook handler tests for assignee filtering
 *
 * Test Coverage:
 * - Assignee filtering: ignored for unassigned issues when username set
 * - Assignee filtering: ignored for issues assigned to other users
 * - Assignee filtering: processes issues assigned to cluster username
 * - Assignee filtering: backward compat when no username configured
 * - Assignee filtering: handles missing assignees field in payload gracefully
 * - Core webhook behavior: signature verification, action filtering, repo whitelist
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { setupWebhookRoutes } from '../webhooks.js';
import type { LabelMonitorService } from '../../services/label-monitor-service.js';
import type { GitHubWebhookPayload } from '../../types/index.js';

// ==========================================================================
// Mock Factories
// ==========================================================================

function createMockMonitorService(
  overrides: Partial<LabelMonitorService> = {},
): LabelMonitorService {
  return {
    parseLabelEvent: vi.fn().mockReturnValue({
      type: 'process',
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      labelName: 'process:speckit-feature',
      parsedName: 'speckit-feature',
      source: 'webhook',
      issueLabels: ['process:speckit-feature'],
    }),
    processLabelEvent: vi.fn().mockResolvedValue(true),
    verifyAndProcessCompletedLabel: vi.fn().mockResolvedValue(false),
    recordWebhookEvent: vi.fn(),
    poll: vi.fn().mockResolvedValue(undefined),
    startPolling: vi.fn().mockResolvedValue(undefined),
    stopPolling: vi.fn(),
    getState: vi.fn().mockReturnValue({
      isPolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: 30000,
      basePollIntervalMs: 30000,
    }),
    ...overrides,
  } as unknown as LabelMonitorService;
}

/**
 * Create a minimal valid GitHub label webhook payload
 */
function createWebhookPayload(
  overrides: Partial<GitHubWebhookPayload> = {},
): GitHubWebhookPayload {
  return {
    action: 'labeled',
    label: {
      name: 'process:speckit-feature',
      color: '0075ca',
      description: 'Trigger speckit-feature workflow',
    },
    issue: {
      number: 42,
      title: 'Implement feature X',
      labels: [{ name: 'process:speckit-feature' }],
      assignees: [{ login: 'my-bot' }],
      ...overrides.issue,
    },
    repository: {
      owner: { login: 'test-org' },
      name: 'test-repo',
      full_name: 'test-org/test-repo',
      ...overrides.repository,
    },
    ...overrides,
    // Re-apply nested overrides that would otherwise be clobbered
    ...(overrides.issue ? { issue: { ...{ number: 42, title: 'Implement feature X', labels: [{ name: 'process:speckit-feature' }], assignees: [{ login: 'my-bot' }] }, ...overrides.issue } } : {}),
    ...(overrides.repository ? { repository: { ...{ owner: { login: 'test-org' }, name: 'test-repo', full_name: 'test-org/test-repo' }, ...overrides.repository } } : {}),
  };
}

/**
 * Compute HMAC-SHA256 signature for webhook payload
 */
function computeSignature(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

// ==========================================================================
// Test Server Setup
// ==========================================================================

interface ServerOptions {
  monitorService?: LabelMonitorService;
  webhookSecret?: string;
  watchedRepos?: Set<string>;
  clusterGithubUsername?: string;
}

async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  const monitorService = options.monitorService ?? createMockMonitorService();
  const webhookSecret = options.webhookSecret;
  const watchedRepos = options.watchedRepos ?? new Set(['test-org/test-repo']);
  const clusterGithubUsername = options.clusterGithubUsername;

  await setupWebhookRoutes(server, {
    monitorService,
    webhookSecret,
    watchedRepos,
    clusterGithubUsername,
  });

  return server;
}

/**
 * Helper to inject a label webhook POST request
 */
async function injectWebhook(
  server: FastifyInstance,
  payload: GitHubWebhookPayload,
  headers: Record<string, string> = {},
) {
  const rawBody = JSON.stringify(payload);
  return server.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    payload: rawBody,
  });
}

// ==========================================================================
// Tests
// ==========================================================================

describe('Label Webhook Route - POST /webhooks/github', () => {
  let server: FastifyInstance;
  let monitorService: LabelMonitorService;

  beforeEach(() => {
    monitorService = createMockMonitorService();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  // ==========================================================================
  // HMAC-SHA256 Signature Verification
  // ==========================================================================

  describe('signature verification', () => {
    it('should accept valid HMAC-SHA256 signature', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);
      const signature = computeSignature(secret, rawBody);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should reject invalid HMAC-SHA256 signature', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'x-hub-signature-256': 'sha256=invalid',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });

    it('should accept requests without signature when no secret is configured', async () => {
      server = await buildServer({ monitorService, webhookSecret: undefined });

      const payload = createWebhookPayload();
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Action Filtering
  // ==========================================================================

  describe('action filtering', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should process labeled events', async () => {
      const payload = createWebhookPayload({ action: 'labeled' });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should ignore non-labeled events', async () => {
      const payload = createWebhookPayload({ action: 'opened' });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a labeled event',
      });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Repository Whitelist
  // ==========================================================================

  describe('repository whitelist', () => {
    it('should process events from watched repositories', async () => {
      server = await buildServer({ monitorService });

      const payload = createWebhookPayload();
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should ignore events from unwatched repositories', async () => {
      server = await buildServer({ monitorService });

      const payload = createWebhookPayload({
        repository: {
          owner: { login: 'other-org' },
          name: 'other-repo',
          full_name: 'other-org/other-repo',
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a watched repository',
      });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Assignee Filtering (T015)
  // ==========================================================================

  describe('assignee filtering', () => {
    it('should return ignored with reason for unassigned issues when username set', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload({
        issue: {
          number: 10,
          title: 'Unassigned issue',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'issue has no assignees',
      });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });

    it('should return ignored with reason for issues assigned to other users', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload({
        issue: {
          number: 11,
          title: 'Someone else issue',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: 'other-dev' }],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not assigned to this cluster',
      });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });

    it('should process issues assigned to cluster username', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload({
        issue: {
          number: 12,
          title: 'My issue',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: 'my-bot' }],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).not.toBe('ignored');
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should process issues when the cluster user is one of multiple assignees', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload({
        issue: {
          number: 13,
          title: 'Multi-assignee issue',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: 'other-dev' }, { login: 'my-bot' }],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should process all issues when no username configured (backward compat)', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: undefined,
      });

      // Issue with no assignees — should still be processed when filtering is off
      const payload = createWebhookPayload({
        issue: {
          number: 14,
          title: 'Unassigned but no filter',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should process all issues assigned to others when no username configured', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: undefined,
      });

      const payload = createWebhookPayload({
        issue: {
          number: 15,
          title: 'Other dev issue but no filter',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: 'other-dev' }],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(monitorService.parseLabelEvent).toHaveBeenCalled();
    });

    it('should handle missing assignees field in payload gracefully (via ?? [])', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      // Simulate payload where assignees is missing/undefined
      const payload = createWebhookPayload();
      // Force-remove assignees to simulate missing field
      (payload.issue as Record<string, unknown>).assignees = undefined;

      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      // With ?? [] fallback, undefined assignees → empty array → "no assignees"
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'issue has no assignees',
      });
      expect(monitorService.parseLabelEvent).not.toHaveBeenCalled();
    });

    it('should check assignees after repo whitelist check', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      // Issue from unwatched repo — should be rejected by repo check, not assignee check
      const payload = createWebhookPayload({
        repository: {
          owner: { login: 'unwatched-org' },
          name: 'unwatched-repo',
          full_name: 'unwatched-org/unwatched-repo',
        },
        issue: {
          number: 16,
          title: 'Wrong repo',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [],
        },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a watched repository',
      });
    });
  });

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  describe('event processing', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should return processed status when processLabelEvent returns true', async () => {
      (monitorService.processLabelEvent as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const payload = createWebhookPayload();
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('processed');
      expect(body.event).toEqual({
        type: 'process',
        issue: 42,
        label: 'process:speckit-feature',
      });
    });

    it('should return duplicate status when processLabelEvent returns false', async () => {
      (monitorService.processLabelEvent as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const payload = createWebhookPayload();
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('duplicate');
    });

    it('should return ignored for non-trigger labels', async () => {
      (monitorService.parseLabelEvent as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const payload = createWebhookPayload({
        label: { name: 'bug', color: 'red', description: '' },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a trigger label',
      });
    });

    it('should record webhook event for adaptive polling', async () => {
      const payload = createWebhookPayload();
      await injectWebhook(server, payload);

      expect(monitorService.recordWebhookEvent).toHaveBeenCalled();
    });

    it('should attempt re-fetch for completed:* labels without matching waiting-for:*', async () => {
      (monitorService.parseLabelEvent as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (monitorService.verifyAndProcessCompletedLabel as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const payload = createWebhookPayload({
        label: { name: 'completed:speckit-feature', color: '0075ca', description: '' },
      });
      const res = await injectWebhook(server, payload);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'processed',
        reason: 'resume detected after label re-fetch',
      });
      expect(monitorService.recordWebhookEvent).toHaveBeenCalled();
      expect(monitorService.verifyAndProcessCompletedLabel).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        'completed:speckit-feature',
      );
    });
  });
});
