/**
 * Unit tests for PR webhook route (POST /webhooks/github/pr-review)
 *
 * T017: [US1] Write unit tests for PR webhook route
 *
 * Test Coverage:
 * - HMAC-SHA256 signature verification (valid, invalid, missing, malformed)
 * - Event type filtering (pull_request_review, pull_request_review_comment, other)
 * - Action filtering (submitted, created, other actions)
 * - Repository whitelist enforcement
 * - Raw body capture for signature verification
 * - Webhook event recording for adaptive polling
 * - Event processing delegation to PrFeedbackMonitorService
 * - Response format (processed vs duplicate vs ignored)
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { setupPrWebhookRoutes } from '../pr-webhooks.js';
import type { PrFeedbackMonitorService } from '../../services/pr-feedback-monitor-service.js';
import type { GitHubPrReviewWebhookPayload } from '../../types/index.js';

// ==========================================================================
// Mock Factories
// ==========================================================================

function createMockMonitorService(
  overrides: Partial<PrFeedbackMonitorService> = {},
): PrFeedbackMonitorService {
  return {
    processPrReviewEvent: vi.fn().mockResolvedValue(true),
    recordWebhookEvent: vi.fn(),
    poll: vi.fn().mockResolvedValue(undefined),
    startPolling: vi.fn().mockResolvedValue(undefined),
    stopPolling: vi.fn(),
    getState: vi.fn().mockReturnValue({
      isPolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: 60000,
      basePollIntervalMs: 60000,
    }),
    ...overrides,
  } as unknown as PrFeedbackMonitorService;
}

/**
 * Create a minimal valid GitHub PR review webhook payload
 */
function createWebhookPayload(
  overrides: Partial<GitHubPrReviewWebhookPayload> = {},
): GitHubPrReviewWebhookPayload {
  return {
    action: 'submitted',
    review: {
      id: 12345,
      state: 'commented',
      body: 'Please fix the tests',
      user: { login: 'reviewer' },
    },
    pull_request: {
      number: 42,
      title: 'Feature: Add tests',
      body: 'Fixes #100',
      head: { ref: '100-add-tests', sha: 'abc123' },
      base: { ref: 'main' },
      state: 'open',
    },
    repository: {
      owner: { login: 'test-org' },
      name: 'test-repo',
      full_name: 'test-org/test-repo',
    },
    ...overrides,
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
  monitorService?: PrFeedbackMonitorService;
  webhookSecret?: string;
  watchedRepos?: Set<string>;
  clusterGithubUsername?: string;
}

async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  // Register the custom content type parser that preserves raw body for
  // signature verification (in production this is done in server.ts via
  // an encapsulated plugin wrapping the webhook routes).
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const json = JSON.parse(body as string);
        done(null, { parsed: json, raw: body });
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const monitorService = options.monitorService ?? createMockMonitorService();
  const webhookSecret = options.webhookSecret;
  const watchedRepos = options.watchedRepos ?? new Set(['test-org/test-repo']);
  const clusterGithubUsername = options.clusterGithubUsername;

  await setupPrWebhookRoutes(server, {
    monitorService,
    webhookSecret,
    watchedRepos,
    clusterGithubUsername,
  });

  return server;
}

// ==========================================================================
// Tests
// ==========================================================================

describe('PR Webhook Route - POST /webhooks/github/pr-review', () => {
  let server: FastifyInstance;
  let monitorService: PrFeedbackMonitorService;

  beforeEach(async () => {
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
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should reject invalid HMAC-SHA256 signature', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);
      const invalidSignature = 'sha256=invalid';

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': invalidSignature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should reject missing signature header when secret is configured', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should accept requests without signature when no secret is configured', async () => {
      server = await buildServer({ monitorService, webhookSecret: undefined });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should reject signature without sha256= prefix', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);
      const hmac = createHmac('sha256', secret).update(rawBody).digest('hex');

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': hmac, // Missing "sha256=" prefix
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
    });

    it('should reject signature with wrong secret', async () => {
      const secret = 'test-secret';
      const wrongSecret = 'wrong-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);
      const signature = computeSignature(wrongSecret, rawBody);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
    });

    it('should handle malformed signature gracefully', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': 'sha256=not-valid-hex',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
    });
  });

  // ==========================================================================
  // Event Type Filtering
  // ==========================================================================

  describe('event type filtering', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should accept pull_request_review events', async () => {
      const payload = createWebhookPayload({ action: 'submitted' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should accept pull_request_review_comment events', async () => {
      const payload = createWebhookPayload({
        action: 'created',
        comment: {
          id: 999,
          body: 'Fix this',
          path: 'src/app.ts',
          line: 10,
          user: { login: 'reviewer' },
        },
      });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review_comment',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should ignore non-PR review events with 200 OK', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'issues',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a PR review event (got: issues)',
      });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should ignore missing x-github-event header', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a PR review event (got: undefined)',
      });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should ignore push events', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'push',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a PR review event (got: push)',
      });
    });
  });

  // ==========================================================================
  // Action Filtering
  // ==========================================================================

  describe('action filtering', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should process pull_request_review with submitted action', async () => {
      const payload = createWebhookPayload({ action: 'submitted' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('processed');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should ignore pull_request_review with edited action', async () => {
      const payload = createWebhookPayload({ action: 'edited' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a submitted review (got action: edited)',
      });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should ignore pull_request_review with dismissed action', async () => {
      const payload = createWebhookPayload({ action: 'dismissed' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a submitted review (got action: dismissed)',
      });
    });

    it('should process pull_request_review_comment with created action', async () => {
      const payload = createWebhookPayload({
        action: 'created',
        comment: {
          id: 999,
          body: 'Fix this',
          path: 'src/app.ts',
          line: 10,
          user: { login: 'reviewer' },
        },
      });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review_comment',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('processed');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should ignore pull_request_review_comment with edited action', async () => {
      const payload = createWebhookPayload({ action: 'edited' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review_comment',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a created comment (got action: edited)',
      });
    });

    it('should ignore pull_request_review_comment with deleted action', async () => {
      const payload = createWebhookPayload({ action: 'deleted' });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review_comment',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a created comment (got action: deleted)',
      });
    });
  });

  // ==========================================================================
  // Repository Whitelist Enforcement
  // ==========================================================================

  describe('repository whitelist', () => {
    it('should process events from watched repositories', async () => {
      const watchedRepos = new Set(['test-org/test-repo', 'other-org/other-repo']);
      server = await buildServer({ monitorService, watchedRepos });

      const payload = createWebhookPayload({
        repository: {
          owner: { login: 'test-org' },
          name: 'test-repo',
          full_name: 'test-org/test-repo',
        },
      });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processed');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should ignore events from unwatched repositories', async () => {
      const watchedRepos = new Set(['test-org/test-repo']);
      server = await buildServer({ monitorService, watchedRepos });

      const payload = createWebhookPayload({
        repository: {
          owner: { login: 'unwatched-org' },
          name: 'unwatched-repo',
          full_name: 'unwatched-org/unwatched-repo',
        },
      });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a watched repository',
      });
      expect(monitorService.processPrReviewEvent).not.toHaveBeenCalled();
    });

    it('should handle empty watched repos set', async () => {
      const watchedRepos = new Set<string>();
      server = await buildServer({ monitorService, watchedRepos });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ignored',
        reason: 'not a watched repository',
      });
    });
  });

  // ==========================================================================
  // Event Processing and Response Format
  // ==========================================================================

  describe('event processing', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should build PrReviewEvent with correct structure from payload', async () => {
      const watchedRepos = new Set(['my-org/my-repo']);
      server = await buildServer({ monitorService, watchedRepos });

      const payload = createWebhookPayload({
        pull_request: {
          number: 99,
          title: 'Test PR',
          body: 'Closes #200',
          head: { ref: '200-feature', sha: 'abc123' },
          base: { ref: 'main' },
          state: 'open',
        },
        repository: {
          owner: { login: 'my-org' },
          name: 'my-repo',
          full_name: 'my-org/my-repo',
        },
      });
      const rawBody = JSON.stringify(payload);

      await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(monitorService.processPrReviewEvent).toHaveBeenCalledWith({
        owner: 'my-org',
        repo: 'my-repo',
        prNumber: 99,
        prBody: 'Closes #200',
        branchName: '200-feature',
        source: 'webhook',
      });
    });

    it('should handle null PR body', async () => {
      const payload = createWebhookPayload({
        pull_request: {
          number: 42,
          title: 'Test',
          body: null,
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          state: 'open',
        },
      });
      const rawBody = JSON.stringify(payload);

      await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(monitorService.processPrReviewEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          prBody: '',
        }),
      );
    });

    it('should record webhook event for adaptive polling', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(monitorService.recordWebhookEvent).toHaveBeenCalled();
    });

    it('should return processed status when processPrReviewEvent returns true', async () => {
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('processed');
      expect(body.event).toEqual({
        type: 'pull_request_review',
        action: 'submitted',
        pr: 42,
        repo: 'test-org/test-repo',
      });
    });

    it('should return duplicate status when processPrReviewEvent returns false', async () => {
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('duplicate');
      expect(body.event).toEqual({
        type: 'pull_request_review',
        action: 'submitted',
        pr: 42,
        repo: 'test-org/test-repo',
      });
    });

    it('should include correct event metadata in response', async () => {
      const payload = createWebhookPayload({
        action: 'created',
        pull_request: {
          number: 123,
          title: 'Test',
          body: 'Test PR',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main' },
          state: 'open',
        },
      });
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review_comment',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.event).toEqual({
        type: 'pull_request_review_comment',
        action: 'created',
        pr: 123,
        repo: 'test-org/test-repo',
      });
    });
  });

  // ==========================================================================
  // Raw Body Capture
  // ==========================================================================

  describe('raw body capture for signature verification', () => {
    it('should preserve raw body for signature verification', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      // Create payload with specific formatting
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload, null, 2); // Formatted JSON
      const signature = computeSignature(secret, rawBody);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      // Should accept because raw body is preserved exactly
      expect(res.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should verify signature against exact raw body bytes', async () => {
      const secret = 'test-secret';
      server = await buildServer({ monitorService, webhookSecret: secret });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      // Compute signature for original body
      const signature = computeSignature(secret, rawBody);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should handle processPrReviewEvent throwing an error', async () => {
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Service error'),
      );

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      // Fastify error handler should catch this
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    });

    it('should handle malformed JSON payload', async () => {
      const rawBody = '{invalid json';

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      // Fastify returns 500 for JSON parsing errors in custom content type parsers
      expect(res.statusCode).toBe(500);
    });

    it('should handle missing required fields in payload', async () => {
      const invalidPayload = {
        action: 'submitted',
        // Missing pull_request and repository
      };
      const rawBody = JSON.stringify(invalidPayload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      // Should fail when trying to access payload.pull_request
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  // ==========================================================================
  // Webhook-to-Enqueue Latency (US1 Acceptance Criteria)
  // ==========================================================================

  describe('latency requirements', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should complete webhook processing in under 500ms', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const startTime = Date.now();

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      const elapsed = Date.now() - startTime;

      expect(res.statusCode).toBe(200);
      // Processing should be fast (well under 500ms for unit test)
      expect(elapsed).toBeLessThan(100);
    });
  });

  // ==========================================================================
  // Integration Scenarios
  // ==========================================================================

  describe('integration scenarios', () => {
    beforeEach(async () => {
      server = await buildServer({ monitorService });
    });

    it('should handle rapid successive webhooks for same PR', async () => {
      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      // First webhook should process
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        true,
      );

      const res1 = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      // Second webhook should be duplicate
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        false,
      );

      const res2 = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res1.json().status).toBe('processed');
      expect(res2.json().status).toBe('duplicate');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple repos in single server instance', async () => {
      const watchedRepos = new Set(['org1/repo1', 'org2/repo2']);
      server = await buildServer({ monitorService, watchedRepos });

      const payload1 = createWebhookPayload({
        repository: {
          owner: { login: 'org1' },
          name: 'repo1',
          full_name: 'org1/repo1',
        },
      });

      const payload2 = createWebhookPayload({
        repository: {
          owner: { login: 'org2' },
          name: 'repo2',
          full_name: 'org2/repo2',
        },
      });

      const res1 = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload1),
      });

      const res2 = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload2),
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(monitorService.processPrReviewEvent).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Assignee Filtering Interface Compatibility (T015)
  //
  // PR webhook does NOT do route-level assignee filtering — the actual
  // filtering happens in PrFeedbackMonitorService.processPrReviewEvent()
  // (tested in T014). These tests verify that the clusterGithubUsername
  // option is accepted without breaking anything.
  // ==========================================================================

  describe('assignee filtering interface compatibility', () => {
    it('should accept clusterGithubUsername in options without affecting processing', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processed');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should work without clusterGithubUsername (backward compat)', async () => {
      server = await buildServer({
        monitorService,
        clusterGithubUsername: undefined,
      });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processed');
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
    });

    it('should delegate assignee filtering to service layer, not route layer', async () => {
      // Even with clusterGithubUsername set, the PR webhook route should
      // always pass events through to the monitor service (unlike label webhook
      // which does route-level filtering)
      (monitorService.processPrReviewEvent as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      server = await buildServer({
        monitorService,
        clusterGithubUsername: 'my-bot',
      });

      const payload = createWebhookPayload();
      const rawBody = JSON.stringify(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      // Service was still called — route didn't filter
      expect(monitorService.processPrReviewEvent).toHaveBeenCalled();
      expect(res.json().status).toBe('duplicate');
    });
  });
});
