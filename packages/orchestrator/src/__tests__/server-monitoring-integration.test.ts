/**
 * Integration test: label monitoring with Fastify server
 *
 * T022: Verifies the end-to-end flow of label monitoring through the live
 * Fastify server — from webhook receipt to queue enqueue — using mocked
 * GitHub API calls and the InMemoryQueueAdapter.
 *
 * Test Coverage:
 * - Webhook endpoint processes `process:*` labeled events and enqueues items
 * - Queue depth and items are observable via dispatch routes after enqueue
 * - Webhook signature verification (valid, invalid, missing)
 * - Non-trigger labels are ignored (e.g., `enhancement`)
 * - Non-labeled actions are ignored (e.g., `unlabeled`)
 * - Unwatched repositories are ignored
 * - Assignee filtering rejects issues not assigned to cluster
 * - `completed:*` webhook triggers re-fetch verification for resume detection
 * - Monitor state tracks webhook health via adaptive polling
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Mock @generacy-ai/workflow-engine before any imports that use it
const mockGitHubClient = {
  getIssue: vi.fn().mockResolvedValue({
    title: 'Test issue title',
    body: 'Test issue body',
    labels: [{ name: 'process:speckit-feature', color: 'D876E3' }],
    assignees: [],
  }),
  addLabels: vi.fn().mockResolvedValue(undefined),
  removeLabels: vi.fn().mockResolvedValue(undefined),
  listLabels: vi.fn().mockResolvedValue([]),
  listIssuesWithLabel: vi.fn().mockResolvedValue([]),
  createLabel: vi.fn().mockResolvedValue(undefined),
  updateLabel: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...original,
    createGitHubClient: vi.fn(() => mockGitHubClient),
  };
});

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

const WEBHOOK_SECRET = 'test-webhook-secret-for-hmac';
const WATCHED_OWNER = 'test-org';
const WATCHED_REPO = 'test-repo';
const CLUSTER_USERNAME = 'cluster-bot';

function computeSignature(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

function buildWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    label: {
      name: 'process:speckit-feature',
      color: 'D876E3',
      description: 'Speckit feature process trigger',
    },
    issue: {
      number: 42,
      title: 'Test issue',
      labels: [{ name: 'process:speckit-feature' }],
      assignees: [{ login: CLUSTER_USERNAME }],
    },
    repository: {
      owner: { login: WATCHED_OWNER },
      name: WATCHED_REPO,
      full_name: `${WATCHED_OWNER}/${WATCHED_REPO}`,
    },
    ...overrides,
  };
}

function injectWebhook(
  server: FastifyInstance,
  payload: Record<string, unknown>,
  options: { signature?: string | false; eventType?: string } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'x-github-event': options.eventType ?? 'issues',
    'content-type': 'application/json',
  };
  if (options.signature !== false) {
    headers['x-hub-signature-256'] =
      options.signature ?? computeSignature(WEBHOOK_SECRET, body);
  }

  return server.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers,
    payload: body,
  });
}

describe('T022: label monitoring with Fastify server', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    // Reset mocks before server creation
    vi.clearAllMocks();

    const config = createTestConfig({
      server: { port: 0, host: '127.0.0.1' },
      redis: { url: 'redis://127.0.0.1:1' }, // Unreachable → in-memory fallback
      auth: {
        enabled: false,
        providers: [],
        jwt: {
          secret: 'test-secret-at-least-32-characters-long',
          expiresIn: '1h',
        },
      },
      logging: { level: 'error', pretty: false },
      repositories: [{ owner: WATCHED_OWNER, repo: WATCHED_REPO }],
      monitor: {
        pollIntervalMs: 300000, // Very long to prevent auto-polling during tests
        webhookSecret: WEBHOOK_SECRET,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
        clusterGithubUsername: CLUSTER_USERNAME,
      },
      prMonitor: { enabled: false },
    });

    server = await createServer({ config });
    await server.ready();
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  // ==========================================================================
  // Webhook → Queue enqueue flow
  // ==========================================================================

  describe('webhook → queue enqueue flow', () => {
    it('should enqueue a process:* labeled event and reflect in queue depth', async () => {
      // Clear mocks from server startup
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Test issue title',
        body: 'Test issue body',
        labels: [{ name: 'process:speckit-feature', color: 'D876E3' }],
        assignees: [],
      });

      const payload = buildWebhookPayload();
      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('processed');
      expect(body.event).toEqual({
        type: 'process',
        issue: 42,
        label: 'process:speckit-feature',
      });

      // Verify item appeared in the dispatch queue
      const depthResponse = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/depth',
      });
      expect(depthResponse.statusCode).toBe(200);
      const depthBody = JSON.parse(depthResponse.payload);
      expect(depthBody.depth).toBeGreaterThanOrEqual(1);

      // Verify queue items contain the enqueued issue
      const itemsResponse = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/items',
      });
      expect(itemsResponse.statusCode).toBe(200);
      const itemsBody = JSON.parse(itemsResponse.payload);
      const enqueuedItem = itemsBody.items.find(
        (entry: { item: { issueNumber: number } }) => entry.item.issueNumber === 42,
      );
      expect(enqueuedItem).toBeDefined();
      expect(enqueuedItem.item.owner).toBe(WATCHED_OWNER);
      expect(enqueuedItem.item.repo).toBe(WATCHED_REPO);
      expect(enqueuedItem.item.workflowName).toBe('speckit-feature');
      expect(enqueuedItem.item.command).toBe('process');
    });

    it('should include issue description in queue item metadata', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Another issue',
        body: 'Rich description here',
        labels: [{ name: 'process:speckit-bugfix', color: 'D876E3' }],
        assignees: [],
      });

      const payload = buildWebhookPayload({
        label: { name: 'process:speckit-bugfix', color: 'D876E3', description: '' },
        issue: {
          number: 99,
          title: 'Another issue',
          labels: [{ name: 'process:speckit-bugfix' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).status).toBe('processed');

      // Check queue item metadata
      const itemsResponse = await server.inject({
        method: 'GET',
        url: '/dispatch/queue/items',
      });
      const itemsBody = JSON.parse(itemsResponse.payload);
      const item = itemsBody.items.find(
        (entry: { item: { issueNumber: number } }) => entry.item.issueNumber === 99,
      );
      expect(item).toBeDefined();
      expect(item.item.metadata.description).toBe('Rich description here');
    });
  });

  // ==========================================================================
  // Webhook signature verification
  // ==========================================================================

  describe('webhook signature verification', () => {
    it('should reject requests with invalid signature', async () => {
      const payload = buildWebhookPayload({
        issue: {
          number: 200,
          title: 'Bad sig',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload, {
        signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Invalid signature');
    });

    it('should reject requests with missing signature header', async () => {
      const payload = buildWebhookPayload({
        issue: {
          number: 201,
          title: 'No sig',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload, { signature: false });

      expect(response.statusCode).toBe(401);
    });

    it('should accept requests with valid HMAC-SHA256 signature', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Valid sig issue',
        body: 'body',
        labels: [{ name: 'process:speckit-feature', color: '' }],
        assignees: [],
      });

      const payload = buildWebhookPayload({
        issue: {
          number: 202,
          title: 'Valid sig issue',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).status).toBe('processed');
    });
  });

  // ==========================================================================
  // Non-trigger labels and actions
  // ==========================================================================

  describe('non-trigger labels and actions', () => {
    it('should ignore non-trigger labels (e.g., enhancement)', async () => {
      const payload = buildWebhookPayload({
        label: { name: 'enhancement', color: '000000', description: '' },
        issue: {
          number: 300,
          title: 'Enhancement issue',
          labels: [{ name: 'enhancement' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('not a trigger label');
    });

    it('should ignore non-labeled actions (e.g., unlabeled)', async () => {
      const payload = buildWebhookPayload({ action: 'unlabeled' });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('not a labeled event');
    });

    it('should ignore events from unwatched repositories', async () => {
      const payload = buildWebhookPayload({
        repository: {
          owner: { login: 'other-org' },
          name: 'other-repo',
          full_name: 'other-org/other-repo',
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('not a watched repository');
    });
  });

  // ==========================================================================
  // Assignee filtering
  // ==========================================================================

  describe('assignee filtering via webhook', () => {
    it('should ignore issues not assigned to the cluster', async () => {
      const payload = buildWebhookPayload({
        issue: {
          number: 400,
          title: 'Wrong assignee',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [{ login: 'other-user' }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('not assigned to this cluster');
    });

    it('should ignore issues with no assignees', async () => {
      const payload = buildWebhookPayload({
        issue: {
          number: 401,
          title: 'No assignee',
          labels: [{ name: 'process:speckit-feature' }],
          assignees: [],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('issue has no assignees');
    });
  });

  // ==========================================================================
  // Resume detection via completed:* webhook
  // ==========================================================================

  describe('completed:* webhook re-fetch verification', () => {
    it('should process resume when re-fetch finds matching waiting-for:* label', async () => {
      // Webhook payload has completed:spec-review but no waiting-for:spec-review
      // (simulates stale payload). Re-fetch should find the matching label.
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Resume issue',
        body: 'Resume body',
        labels: [
          { name: 'completed:spec-review', color: '' },
          { name: 'waiting-for:spec-review', color: '' },
          { name: 'workflow:speckit-feature', color: '' },
        ],
        assignees: [],
      });

      const payload = buildWebhookPayload({
        label: { name: 'completed:spec-review', color: '0E8A16', description: '' },
        issue: {
          number: 500,
          title: 'Resume issue',
          labels: [
            { name: 'completed:spec-review' },
            // Note: no waiting-for:spec-review in the webhook payload
          ],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('processed');
      expect(body.reason).toBe('resume detected after label re-fetch');
    });

    it('should return ignored when re-fetch confirms no waiting-for:* label', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'No resume issue',
        body: 'body',
        labels: [
          { name: 'completed:spec-review', color: '' },
          // No waiting-for:spec-review
        ],
        assignees: [],
      });

      const payload = buildWebhookPayload({
        label: { name: 'completed:spec-review', color: '0E8A16', description: '' },
        issue: {
          number: 501,
          title: 'No resume issue',
          labels: [{ name: 'completed:spec-review' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ignored');
      expect(body.reason).toBe('no matching waiting-for:* after re-fetch');
    });

    it('should process resume directly when webhook payload contains matching pair', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Direct resume',
        body: 'Direct resume body',
        labels: [
          { name: 'completed:plan-review', color: '' },
          { name: 'waiting-for:plan-review', color: '' },
          { name: 'workflow:speckit-feature', color: '' },
        ],
        assignees: [],
      });

      const payload = buildWebhookPayload({
        label: { name: 'completed:plan-review', color: '0E8A16', description: '' },
        issue: {
          number: 502,
          title: 'Direct resume',
          labels: [
            { name: 'completed:plan-review' },
            { name: 'waiting-for:plan-review' },
            { name: 'workflow:speckit-feature' },
          ],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('processed');
      expect(body.event.type).toBe('resume');
      expect(body.event.label).toBe('completed:plan-review');
    });
  });

  // ==========================================================================
  // Label management side-effects
  // ==========================================================================

  describe('label management on process events', () => {
    it('should remove trigger label and add workflow + in-progress labels', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        title: 'Label mgmt issue',
        body: 'body',
        labels: [{ name: 'process:speckit-bugfix', color: '' }],
        assignees: [],
      });
      mockGitHubClient.removeLabels.mockClear();
      mockGitHubClient.addLabels.mockClear();

      const payload = buildWebhookPayload({
        label: { name: 'process:speckit-bugfix', color: 'D876E3', description: '' },
        issue: {
          number: 600,
          title: 'Label mgmt issue',
          labels: [{ name: 'process:speckit-bugfix' }],
          assignees: [{ login: CLUSTER_USERNAME }],
        },
      });

      const response = await injectWebhook(server, payload);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).status).toBe('processed');

      // Verify label operations
      expect(mockGitHubClient.removeLabels).toHaveBeenCalledWith(
        WATCHED_OWNER,
        WATCHED_REPO,
        600,
        expect.arrayContaining(['process:speckit-bugfix', 'agent:error']),
      );
      expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
        WATCHED_OWNER,
        WATCHED_REPO,
        600,
        ['agent:in-progress', 'workflow:speckit-bugfix'],
      );
    });
  });

  // ==========================================================================
  // Health endpoint bypasses webhook auth
  // ==========================================================================

  describe('health endpoints remain accessible', () => {
    it('GET /health should return 200', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
    });
  });
});
