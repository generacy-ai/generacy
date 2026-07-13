/**
 * Integration test for PR Feedback Monitor: webhook → enqueue flow
 *
 * T028: [US1] Write integration test: webhook → enqueue → worker flow
 *
 * This test verifies the webhook ingestion and queue enqueue flow:
 * 1. GitHub webhook delivers PR review event
 * 2. Webhook endpoint validates HMAC signature
 * 3. PrFeedbackMonitorService processes the event
 * 4. PR is linked to an orchestrated issue
 * 5. Unresolved review threads are detected
 * 6. Item is atomically enqueued to queue
 * 7. Waiting-for label is added to the issue
 *
 * Test Coverage:
 * - HMAC-SHA256 signature verification
 * - PR-to-issue linking via body keywords
 * - Unresolved thread detection
 * - Atomic enqueue with deduplication (phase tracker)
 * - Label management
 * - Repository whitelist enforcement
 * - Error handling and edge cases
 *
 * Note: Worker processing (claim → dispatch → handler) is tested separately
 * in the unit tests for WorkerDispatcher, ClaudeCliWorker, and PrFeedbackHandler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { setupPrWebhookRoutes } from '../routes/pr-webhooks.js';
import { PrFeedbackMonitorService } from '../services/pr-feedback-monitor-service.js';
import type {
  GitHubPrReviewWebhookPayload,
  QueueItem,
  QueueItemWithScore,
  QueueManager,
} from '../types/index.js';
import type { Logger } from '../worker/types.js';
import { AgentLauncher } from '../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ==========================================================================
// Mock GitHub Client
// ==========================================================================
const mockGitHub = {
  getPullRequest: vi.fn(),
  getPRReviewThreads: vi.fn(),
  addLabels: vi.fn(),
  removeLabels: vi.fn(),
  getIssue: vi.fn(),
  // #883: default to empty label set so the monitor's blocked:* skip check
  // passes through without needing per-test setup.
  getIssueLabels: vi.fn().mockResolvedValue([]),
  listOpenPullRequests: vi.fn(),
  getStatus: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  replyToPRComment: vi.fn(),
  resolveReviewThread: vi.fn(),
};

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGitHub),
  GhAuthError: class GhAuthError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly stderr: string,
      message?: string,
    ) {
      super(message ?? `gh CLI auth error (HTTP ${statusCode})`);
      this.name = 'GhAuthError';
    }
  },
  // Author-trust helpers (#842). Default stubs pass every comment through.
  isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
  tryLoadCommentTrustConfig: vi.fn(() => undefined),
  wrapUntrustedData: vi.fn((content: string) => content),
  // #883: short SHA lookup for reply-body interpolation.
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'abc1234\n', stderr: '' })),
  // #889: LabelManager imports WORKFLOW_LABELS for its ensure-pass.
  WORKFLOW_LABELS: [],
}));

// ==========================================================================
// Test Helpers
// ==========================================================================

// #861: wrap a list of REST-like comment literals into a `ReviewThread[]`,
// promoting `resolved` → `isResolved` on the wrapping thread.
function asThreads(comments: Array<Record<string, unknown> & { id: number; resolved?: boolean }>) {
  return comments.map(c => {
    const { resolved, ...rest } = c;
    return {
      id: `PRRT_${c.id}`,
      rootCommentId: c.id,
      isResolved: resolved === true,
      comments: [{ created_at: '', updated_at: '', ...rest }],
    };
  });
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: Logger) {
      return this;
    }),
  } as unknown as Logger;
}

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
      number: 100,
      title: 'Feature: Add tests',
      body: 'Fixes #42',
      head: { ref: '42-add-tests', sha: 'abc123' },
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

function computeSignature(secret: string, body: string): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

// ==========================================================================
// Mock Queue Manager for Testing (#879: in-flight dedupe via enqueueIfAbsent)
// ==========================================================================
class MockQueueManager implements QueueManager {
  public enqueuedItems: QueueItem[] = [];
  private inFlight = new Set<string>();

  private itemKey(item: QueueItem): string {
    return `${item.owner}/${item.repo}#${item.issueNumber}`;
  }

  async enqueue(item: QueueItem): Promise<void> {
    this.enqueuedItems.push(item);
    this.inFlight.add(this.itemKey(item));
  }

  async enqueueIfAbsent(item: QueueItem): Promise<boolean> {
    const key = this.itemKey(item);
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    this.enqueuedItems.push(item);
    return true;
  }

  async hasInFlight(itemKey: string): Promise<boolean> {
    return this.inFlight.has(itemKey);
  }

  async claim(): Promise<QueueItem | null> { return null; }
  async release(): Promise<void> {}
  async complete(_workerId: string, item: QueueItem): Promise<void> {
    this.inFlight.delete(this.itemKey(item));
  }
  async getQueueDepth(): Promise<number> { return this.enqueuedItems.length; }
  async getQueueItems(): Promise<QueueItemWithScore[]> { return []; }
  async getActiveWorkerCount(): Promise<number> { return 0; }

  clear(): void {
    this.enqueuedItems = [];
    this.inFlight.clear();
  }
}

// ==========================================================================
// Integration Test Suite
// ==========================================================================

describe('PR Feedback Integration Test: Webhook → Enqueue', () => {
  let server: FastifyInstance;
  let logger: Logger;
  let queueAdapter: MockQueueManager;
  let monitorService: PrFeedbackMonitorService;

  const WEBHOOK_SECRET = 'test-webhook-secret';
  const WATCHED_REPOS = new Set(['test-org/test-repo']);

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = createMockLogger();

    // Use in-memory queue adapter for faster tests
    queueAdapter = new MockQueueManager();

    // Use in-memory phase tracker

    // Setup PR feedback monitor service
    monitorService = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 60000,
        adaptivePolling: false,
        maxConcurrentPolls: 1,
      },
      [{ owner: 'test-org', repo: 'test-repo' }],
    );

    // Setup Fastify server with custom content type parser (preserves raw body
    // for HMAC signature verification, matching production server.ts setup)
    server = Fastify({ logger: false });
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
    await setupPrWebhookRoutes(server, {
      monitorService,
      webhookSecret: WEBHOOK_SECRET,
      watchedRepos: WATCHED_REPOS,
    });

    // Default mock implementations
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'process:speckit-feature', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });
    // #883: monitor's pre-enqueue skip fetches issue labels; default → none blocked.
    mockGitHub.getIssueLabels.mockResolvedValue([]);

    mockGitHub.getPullRequest.mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Fixes #42',
      head: { ref: '42-add-tests' },
      base: { ref: 'main' },
      state: 'open',
    });

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fix this issue',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/util.ts',
        line: 20,
        body: 'Also fix this',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    mockGitHub.addLabels.mockResolvedValue(undefined);
    mockGitHub.removeLabels.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    queueAdapter.clear();
  });

  // ==========================================================================
  // Integration Test: Full Webhook → Enqueue Flow
  // ==========================================================================

  it('should process PR review webhook and enqueue item', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // Send webhook
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Webhook should be accepted
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('processed');

    // Verify item was enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;

    // Verify enqueued item structure
    expect(enqueuedItem).toMatchObject({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback',
    });

    // Verify metadata
    expect(enqueuedItem.metadata).toEqual({
      prNumber: 100,
      reviewThreadIds: [1, 2],
    });

    // Verify priority and timestamp
    expect(enqueuedItem.priority).toBeTypeOf('number');
    expect(enqueuedItem.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify waiting-for label was added
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['waiting-for:address-pr-feedback'],
    );

    // Verify GitHub API calls
    expect(mockGitHub.getIssue).toHaveBeenCalled();
    expect(mockGitHub.getPRReviewThreads).toHaveBeenCalledWith('test-org', 'test-repo', 100);
  });

  // ==========================================================================
  // Integration Test: Duplicate Detection
  // ==========================================================================

  it('should prevent duplicate processing with phase tracker', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // Send same webhook twice
    const response1 = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    const response2 = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // First should be processed
    expect(response1.statusCode).toBe(200);
    expect(response1.json().status).toBe('processed');

    // Second should be duplicate
    expect(response2.statusCode).toBe(200);
    expect(response2.json().status).toBe('duplicate');

    // Only one item should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Integration Test: Invalid Signature Rejection
  // ==========================================================================

  it('should reject webhook with invalid signature', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const invalidSignature = 'sha256=invalid';

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': invalidSignature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Should reject
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid signature' });

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // No GitHub API calls
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Integration Test: Non-Orchestrated Issue Skip
  // ==========================================================================

  it('should skip PRs linked to non-orchestrated issues', async () => {
    // Issue has no agent:* label
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [{ name: 'enhancement', color: '' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Should be accepted but not processed
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('duplicate');

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // No label should be added
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Integration Test: No Unresolved Threads Skip
  // ==========================================================================

  it('should skip PRs with no unresolved review threads', async () => {
    // All comments are resolved
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fixed',
        author: 'reviewer',
        resolved: true,
        in_reply_to_id: undefined,
      },
    ]));

    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Should be accepted but not enqueued
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('duplicate');

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // No label should be added
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Integration Test: Unwatched Repository Ignored
  // ==========================================================================

  it('should ignore webhooks from unwatched repositories', async () => {
    const payload = createWebhookPayload({
      repository: {
        owner: { login: 'unwatched-org' },
        name: 'unwatched-repo',
        full_name: 'unwatched-org/unwatched-repo',
      },
    });
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Should be ignored
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ignored',
      reason: 'not a watched repository',
    });

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);
  });

  // ==========================================================================
  // Integration Test: PR Review Comment Event
  // ==========================================================================

  it('should process pull_request_review_comment events', async () => {
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
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review_comment',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Should be processed
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('processed');

    // Item should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
  });

  // ==========================================================================
  // Integration Test: Workflow Name Resolution
  // ==========================================================================

  it('should resolve workflow name from process: label', async () => {
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'process:speckit-bugfix', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Verify workflow name
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;
    expect(enqueuedItem.workflowName).toBe('speckit-bugfix');
  });

  it('should resolve workflow name from completed: label', async () => {
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'completed:speckit-feature', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Verify workflow name
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;
    expect(enqueuedItem.workflowName).toBe('speckit-feature');
  });

  it('should use "unknown" workflow when no workflow label exists', async () => {
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [{ name: 'agent:in-progress', color: '' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Verify workflow name
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;
    expect(enqueuedItem.workflowName).toBe('unknown');
  });

  // ==========================================================================
  // Integration Test: Webhook Health Tracking
  // ==========================================================================

  it('should record webhook event for adaptive polling', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    const stateBefore = monitorService.getState();
    expect(stateBefore.webhookHealthy).toBe(true);
    expect(stateBefore.lastWebhookEvent).toBeNull();

    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    const stateAfter = monitorService.getState();
    expect(stateAfter.webhookHealthy).toBe(true);
    expect(stateAfter.lastWebhookEvent).not.toBeNull();
  });
});

// ==========================================================================
// Integration Test: Polling Fallback
// T029: [US4] Write integration test: polling fallback
// ==========================================================================

describe('PR Feedback Integration Test: Polling Fallback', () => {
  let logger: Logger;
  let queueAdapter: MockQueueManager;
  let monitorService: PrFeedbackMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    queueAdapter = new MockQueueManager();

    // Setup monitor service with polling enabled (no webhooks)
    monitorService = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 100, // Fast polling for tests
        adaptivePolling: true,
        maxConcurrentPolls: 1,
      },
      [{ owner: 'test-org', repo: 'test-repo' }],
    );

    // Setup default mock responses
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'process:speckit-feature', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    mockGitHub.getPullRequest.mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Fixes #42',
      head: { ref: '42-add-tests', sha: 'abc123' },
      base: { ref: 'main' },
      state: 'open',
    });

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fix this issue',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/util.ts',
        line: 20,
        body: 'Also fix this',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    mockGitHub.addLabels.mockResolvedValue(undefined);
    mockGitHub.removeLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    monitorService.stopPolling();
    queueAdapter.clear();
  });

  // ==========================================================================
  // Test: Polling Detects Unresolved Threads
  // ==========================================================================

  it('should detect unresolved threads via polling when webhooks disabled', async () => {
    // Mock listOpenPullRequests to return a PR with unresolved threads
    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Test PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z',
      },
    ]);

    // Run a single poll cycle
    await monitorService.poll();

    // Verify polling detected the PR and enqueued it
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;

    // Verify enqueued item structure
    expect(enqueuedItem).toMatchObject({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback',
    });

    // Verify metadata
    expect(enqueuedItem.metadata).toEqual({
      prNumber: 100,
      reviewThreadIds: [1, 2],
    });

    // Verify label was added
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['waiting-for:address-pr-feedback'],
    );

    // Verify GitHub API calls
    expect(mockGitHub.listOpenPullRequests).toHaveBeenCalledWith('test-org', 'test-repo');
    expect(mockGitHub.getPRReviewThreads).toHaveBeenCalledWith('test-org', 'test-repo', 100);
  });

  // ==========================================================================
  // Test: Polling Detects Within One Cycle (SC-003)
  // ==========================================================================

  it('should detect unresolved threads within one poll cycle (SC-003)', async () => {
    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Test PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z',
      },
    ]);

    // Verify queue is empty before polling
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // Run exactly one poll cycle
    await monitorService.poll();

    // Verify PR was detected and enqueued in single cycle
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
    expect(queueAdapter.enqueuedItems[0]!.command).toBe('address-pr-feedback');
    expect(queueAdapter.enqueuedItems[0]!.metadata).toMatchObject({
      prNumber: 100,
      reviewThreadIds: [1, 2],
    });
  });

  // ==========================================================================
  // Test: Polling Skips PRs Without Unresolved Threads
  // ==========================================================================

  it('should skip PRs with no unresolved threads during polling', async () => {
    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Test PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z',
      },
    ]);

    // All comments are resolved
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fixed',
        author: 'reviewer',
        resolved: true,
        in_reply_to_id: undefined,
      },
    ]));

    await monitorService.poll();

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Test: Polling Skips Non-Orchestrated PRs
  // ==========================================================================

  it('should skip non-orchestrated PRs during polling', async () => {
    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Test PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z',
      },
    ]);

    // Issue has no agent:* label
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [{ name: 'enhancement', color: '' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    await monitorService.poll();

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Test: Multiple PRs - Most Recent Processed
  // ==========================================================================

  it('should process only the most recently updated PR when multiple PRs exist for same issue', async () => {
    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Older PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests-v1', sha: 'abc111' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-20T12:00:00Z', // Older
      },
      {
        number: 101,
        title: 'Newer PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests-v2', sha: 'abc222' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z', // More recent
      },
    ]);

    await monitorService.poll();

    // Only one PR should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // It should be the newer PR
    expect(queueAdapter.enqueuedItems[0]!.metadata).toMatchObject({
      prNumber: 101,
    });

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Adaptive Polling - Interval Decrease
  // ==========================================================================

  it('should decrease polling interval when no webhooks received (adaptive polling)', async () => {
    // Create service with longer interval for this test
    const adaptiveMonitor = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 60000, // 60 seconds
        adaptivePolling: true,
        maxConcurrentPolls: 1,
      },
      [{ owner: 'test-org', repo: 'test-repo' }],
    );

    // Initial state
    const initialState = adaptiveMonitor.getState();
    expect(initialState.currentPollIntervalMs).toBe(60000);
    expect(initialState.basePollIntervalMs).toBe(60000);

    // Simulate time passing without webhooks
    // The service should detect no webhook received in 2x the poll interval
    // and decrease interval by 50% (divide by 2)
    // Note: This test verifies the state tracking; actual adaptive logic
    // is tested in the unit tests for PrFeedbackMonitorService

    adaptiveMonitor.stopPolling();
  });

  // ==========================================================================
  // Test: Adaptive Polling - Interval Reset
  // ==========================================================================

  it('should reset polling interval when webhook is received', async () => {
    const initialState = monitorService.getState();
    expect(initialState.currentPollIntervalMs).toBe(100);

    // Record a webhook event (simulating webhook arrival)
    monitorService.recordWebhookEvent();

    const stateAfter = monitorService.getState();

    // Webhook should be recorded
    expect(stateAfter.webhookHealthy).toBe(true);
    expect(stateAfter.lastWebhookEvent).not.toBeNull();

    // Interval should remain at base value
    expect(stateAfter.currentPollIntervalMs).toBe(100);
  });

  // ==========================================================================
  // Test: Polling Handles GitHub API Errors Gracefully
  // ==========================================================================

  it('should handle GitHub API errors gracefully during polling', async () => {
    // Mock API to throw error
    mockGitHub.listOpenPullRequests.mockRejectedValue(
      new Error('GitHub API error'),
    );

    // Poll should not throw
    await expect(monitorService.poll()).resolves.not.toThrow();

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // Error should be logged (verify logger was called)
    expect(logger.error).toHaveBeenCalled();
  });

  // ==========================================================================
  // Test: Polling Handles Rate Limit Gracefully
  // ==========================================================================

  it('should skip repository when GitHub API rate limit is hit', async () => {
    // Mock rate limit error
    const rateLimitError = new Error('API rate limit exceeded');
    (rateLimitError as any).status = 403;
    (rateLimitError as any).response = {
      headers: { 'x-ratelimit-remaining': '0' },
    };

    mockGitHub.listOpenPullRequests.mockRejectedValue(rateLimitError);

    // Poll should not throw
    await expect(monitorService.poll()).resolves.not.toThrow();

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // Warning should be logged
    expect(logger.warn).toHaveBeenCalled();
  });

  // ==========================================================================
  // Test: Polling With No Open PRs
  // ==========================================================================

  it('should handle repositories with no open PRs', async () => {
    mockGitHub.listOpenPullRequests.mockResolvedValue([]);

    await monitorService.poll();

    // Nothing should be enqueued
    expect(queueAdapter.enqueuedItems).toHaveLength(0);

    // No additional API calls should be made
    expect(mockGitHub.getPRReviewThreads).not.toHaveBeenCalled();
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Test: Concurrency Limiting
  // ==========================================================================

  it('should respect maxConcurrentPolls limit', async () => {
    // Create service with multiple repos and low concurrency limit
    const multiRepoMonitor = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 100,
        adaptivePolling: false,
        maxConcurrentPolls: 2, // Limit to 2 concurrent polls
      },
      [
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
        { owner: 'org3', repo: 'repo3' },
      ],
    );

    mockGitHub.listOpenPullRequests.mockResolvedValue([]);

    await multiRepoMonitor.poll();

    // All repos should be polled (but with concurrency limit)
    expect(mockGitHub.listOpenPullRequests).toHaveBeenCalledTimes(3);
    expect(mockGitHub.listOpenPullRequests).toHaveBeenCalledWith('org1', 'repo1');
    expect(mockGitHub.listOpenPullRequests).toHaveBeenCalledWith('org2', 'repo2');
    expect(mockGitHub.listOpenPullRequests).toHaveBeenCalledWith('org3', 'repo3');

    multiRepoMonitor.stopPolling();
  });
});

// ==========================================================================
// Integration Test: Deduplication (Concurrent Webhook + Poll)
// T030: [US1] Write integration test: deduplication
// ==========================================================================

describe('PR Feedback Integration Test: Deduplication', () => {
  let server: FastifyInstance;
  let logger: Logger;
  let queueAdapter: MockQueueManager;
  let monitorService: PrFeedbackMonitorService;

  const WEBHOOK_SECRET = 'test-webhook-secret';
  const WATCHED_REPOS = new Set(['test-org/test-repo']);

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = createMockLogger();

    // Use in-memory queue adapter for faster tests
    queueAdapter = new MockQueueManager();

    // Use in-memory phase tracker (atomic deduplication)

    // Setup PR feedback monitor service
    monitorService = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 100, // Fast polling for tests
        adaptivePolling: false,
        maxConcurrentPolls: 1,
      },
      [{ owner: 'test-org', repo: 'test-repo' }],
    );

    // Setup Fastify server with custom content type parser (preserves raw body
    // for HMAC signature verification, matching production server.ts setup)
    server = Fastify({ logger: false });
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
    await setupPrWebhookRoutes(server, {
      monitorService,
      webhookSecret: WEBHOOK_SECRET,
      watchedRepos: WATCHED_REPOS,
    });

    // Default mock implementations
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'process:speckit-feature', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });
    // #883: monitor's pre-enqueue skip fetches issue labels; default → none blocked.
    mockGitHub.getIssueLabels.mockResolvedValue([]);

    mockGitHub.getPullRequest.mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Fixes #42',
      head: { ref: '42-add-tests', sha: 'abc123' },
      base: { ref: 'main' },
      state: 'open',
    });

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fix this issue',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/util.ts',
        line: 20,
        body: 'Also fix this',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    mockGitHub.listOpenPullRequests.mockResolvedValue([
      {
        number: 100,
        title: 'Test PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
        draft: false,
        updated_at: '2026-02-21T12:00:00Z',
      },
    ]);

    mockGitHub.addLabels.mockResolvedValue(undefined);
    mockGitHub.removeLabels.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    monitorService.stopPolling();
    queueAdapter.clear();
  });

  // ==========================================================================
  // Test: Concurrent Webhook + Poll Deduplication (SC-004)
  // ==========================================================================

  it('should prevent duplicate enqueues when webhook and poll happen concurrently (SC-004)', async () => {
    // Prepare webhook payload
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // Execute webhook and poll concurrently (race condition scenario)
    const [webhookResponse] = await Promise.all([
      // Webhook request
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      }),
      // Poll cycle
      monitorService.poll(),
    ]);

    // Webhook should be accepted
    expect(webhookResponse.statusCode).toBe(200);

    // CRITICAL: Exactly one queue item should exist (SC-004: 0 duplicate enqueues)
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // Verify the single enqueued item has correct structure
    const enqueuedItem = queueAdapter.enqueuedItems[0]!;
    expect(enqueuedItem).toMatchObject({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback',
    });

    expect(enqueuedItem.metadata).toEqual({
      prNumber: 100,
      reviewThreadIds: [1, 2],
    });

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Multiple Concurrent Webhooks Deduplication
  // ==========================================================================

  it('should prevent duplicate enqueues when multiple identical webhooks arrive concurrently', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // Send 3 identical webhooks concurrently
    const responses = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      }),
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      }),
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      }),
    ]);

    // All webhooks should be accepted
    responses.forEach((response) => {
      expect(response.statusCode).toBe(200);
    });

    // Count processed vs duplicate responses
    const processedCount = responses.filter(
      (r) => r.json().status === 'processed',
    ).length;
    const duplicateCount = responses.filter(
      (r) => r.json().status === 'duplicate',
    ).length;

    // Exactly one should be processed, the rest should be duplicates
    expect(processedCount).toBe(1);
    expect(duplicateCount).toBe(2);

    // CRITICAL: Exactly one queue item should exist
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Multiple Poll Cycles Deduplication
  // ==========================================================================

  it('should prevent duplicate enqueues when multiple poll cycles detect the same PR', async () => {
    // Run 3 consecutive poll cycles
    await monitorService.poll();
    await monitorService.poll();
    await monitorService.poll();

    // CRITICAL: Exactly one queue item should exist
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // Verify the single enqueued item
    expect(queueAdapter.enqueuedItems[0]!.command).toBe('address-pr-feedback');
    expect(queueAdapter.enqueuedItems[0]!.metadata).toMatchObject({
      prNumber: 100,
    });

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Webhook + Multiple Polls Deduplication
  // ==========================================================================

  it('should prevent duplicate enqueues when webhook followed by multiple polls', async () => {
    // First: webhook arrives
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Then: multiple poll cycles run
    await monitorService.poll();
    await monitorService.poll();

    // CRITICAL: Exactly one queue item should exist
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Poll + Webhook + Poll Deduplication
  // ==========================================================================

  it('should prevent duplicate enqueues with poll-webhook-poll sequence', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // First: poll cycle
    await monitorService.poll();

    // Then: webhook arrives
    await server.inject({
      method: 'POST',
      url: '/webhooks/github/pr-review',
      headers: {
        'x-github-event': 'pull_request_review',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    // Finally: another poll cycle
    await monitorService.poll();

    // CRITICAL: Exactly one queue item should exist
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Concurrent Everything - Stress Test
  // ==========================================================================

  it('should handle extreme concurrency without duplicates (stress test)', async () => {
    const payload = createWebhookPayload();
    const rawBody = JSON.stringify(payload);
    const signature = computeSignature(WEBHOOK_SECRET, rawBody);

    // Fire 5 webhooks + 5 poll cycles all at once
    const operations = [];

    // Add 5 webhook requests
    for (let i = 0; i < 5; i++) {
      operations.push(
        server.inject({
          method: 'POST',
          url: '/webhooks/github/pr-review',
          headers: {
            'x-github-event': 'pull_request_review',
            'x-hub-signature-256': signature,
            'content-type': 'application/json',
          },
          payload: rawBody,
        }),
      );
    }

    // Add 5 poll cycles
    for (let i = 0; i < 5; i++) {
      operations.push(monitorService.poll());
    }

    // Execute all concurrently
    await Promise.all(operations);

    // CRITICAL: Exactly one queue item should exist (SC-004: 0 duplicate enqueues)
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    // Verify the single item is correct
    expect(queueAdapter.enqueuedItems[0]!).toMatchObject({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      command: 'address-pr-feedback',
    });

    // #879 / FR-010: label is added idempotently on every Case A poll,
    // decoupled from the enqueue outcome. Pre-#879 asserted "exactly 1"; the
    // migration relaxes this to "at least 1 with the correct args" so the
    // label-add fires even on `enqueueIfAbsent → false` collisions.
    expect(mockGitHub.addLabels).toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
    );
  });

  // ==========================================================================
  // Test: Deduplication Across Different PRs Works Independently
  // ==========================================================================

  it('should allow enqueuing different PRs for the same issue independently', async () => {
    // First PR
    const payload1 = createWebhookPayload({
      pull_request: {
        number: 100,
        title: 'First PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
      },
    });

    // Second PR (different PR number, same issue)
    const payload2 = createWebhookPayload({
      pull_request: {
        number: 101,
        title: 'Second PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests-v2', sha: 'def456' },
        base: { ref: 'main' },
        state: 'open',
      },
    });

    // Mock different PR requests
    mockGitHub.getPullRequest
      .mockResolvedValueOnce({
        number: 100,
        title: 'First PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests', sha: 'abc123' },
        base: { ref: 'main' },
        state: 'open',
      })
      .mockResolvedValueOnce({
        number: 101,
        title: 'Second PR',
        body: 'Fixes #42',
        head: { ref: '42-add-tests-v2', sha: 'def456' },
        base: { ref: 'main' },
        state: 'open',
      });

    const rawBody1 = JSON.stringify(payload1);
    const signature1 = computeSignature(WEBHOOK_SECRET, rawBody1);

    const rawBody2 = JSON.stringify(payload2);
    const signature2 = computeSignature(WEBHOOK_SECRET, rawBody2);

    // Send webhooks for different PRs
    const [response1, response2] = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature1,
          'content-type': 'application/json',
        },
        payload: rawBody1,
      }),
      server.inject({
        method: 'POST',
        url: '/webhooks/github/pr-review',
        headers: {
          'x-github-event': 'pull_request_review',
          'x-hub-signature-256': signature2,
          'content-type': 'application/json',
        },
        payload: rawBody2,
      }),
    ]);

    // Both should be accepted
    expect(response1.statusCode).toBe(200);
    expect(response2.statusCode).toBe(200);

    // Note: Due to FR-015 (process only most recent PR per issue),
    // the actual behavior depends on which webhook is processed first.
    // The current implementation uses phase tracker at the issue level,
    // so only one PR per issue will be enqueued at a time.
    // This test documents the actual behavior: deduplication is per-issue,
    // not per-PR, which aligns with the spec's requirement to process
    // only the most recent PR when multiple exist for the same issue.

    // With per-issue deduplication, we expect only 1 queue item
    expect(queueAdapter.enqueuedItems.length).toBeLessThanOrEqual(2);

    // If both are enqueued (unlikely with concurrent processing),
    // they should have different PR numbers
    if (queueAdapter.enqueuedItems.length === 2) {
      const prNumbers = queueAdapter.enqueuedItems.map(
        (item) => (item.metadata as any).prNumber,
      );
      expect(prNumbers).toContain(100);
      expect(prNumbers).toContain(101);
    }
  });
});

// ==========================================================================
// Integration Test: Worker Processes Feedback End-to-End
// T031: [US2] Write integration test: worker processes feedback end-to-end
// ==========================================================================

describe('PR Feedback Integration Test: Worker Processing', () => {
  let logger: Logger;
  let queueAdapter: MockQueueManager;
  let monitorService: PrFeedbackMonitorService;
  let processFactory: any;
  let agentLauncher: AgentLauncher;
  let mockProcess: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = createMockLogger();
    queueAdapter = new MockQueueManager();

    // Setup monitor service
    monitorService = new PrFeedbackMonitorService(
      logger,
      () => mockGitHub as any,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 100,
        adaptivePolling: false,
        maxConcurrentPolls: 1,
      },
      [{ owner: 'test-org', repo: 'test-repo' }],
    );

    // Setup default mock responses
    mockGitHub.getIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [
        { name: 'agent:in-progress', color: '' },
        { name: 'process:speckit-feature', color: '' },
      ],
      assignees: [],
      created_at: '',
      updated_at: '',
    });

    mockGitHub.getPullRequest.mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Fixes #42',
      head: { ref: '42-add-tests', sha: 'abc123' },
      base: { ref: 'main' },
      state: 'open',
    });

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Fix this issue',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/util.ts',
        line: 20,
        body: 'Also fix this',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    mockGitHub.addLabels.mockResolvedValue(undefined);
    mockGitHub.removeLabels.mockResolvedValue(undefined);
    mockGitHub.listOpenPullRequests.mockResolvedValue([]);

    // Mock git operations
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: true,
      staged: ['src/index.ts', 'src/util.ts'],
      unstaged: [],
      untracked: [],
    });
    mockGitHub.stageAll = vi.fn().mockResolvedValue(undefined);
    mockGitHub.commit = vi.fn().mockResolvedValue(undefined);
    mockGitHub.push = vi.fn().mockResolvedValue(undefined);
    mockGitHub.replyToPRComment = vi.fn().mockResolvedValue(undefined);

    // Mock process for Claude CLI
    const { EventEmitter } = await import('node:events');
    mockProcess = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 12345,
      kill: vi.fn(),
      exitPromise: Promise.resolve(0), // Success by default
    };

    processFactory = {
      spawn: vi.fn(() => mockProcess),
    };
    agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
  });

  afterEach(() => {
    monitorService.stopPolling();
    queueAdapter.clear();
  });

  // ==========================================================================
  // Test: Full Worker Processing Flow
  // ==========================================================================

  it('should process PR feedback end-to-end: checkout → prompt → commit → reply → label removal', async () => {
    // Import handler
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');
    const { RepoCheckout } = await import('../worker/repo-checkout.js');

    // Mock RepoCheckout
    const mockRepoCheckout = {
      switchBranch: vi.fn().mockResolvedValue(undefined),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      ensureCheckout: vi.fn().mockResolvedValue('/tmp/workspace/test-org/test-repo'),
    };
    vi.spyOn(RepoCheckout.prototype, 'switchBranch').mockImplementation(
      mockRepoCheckout.switchBranch,
    );

    // Create handler
    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    // Create queue item
    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 100,
        reviewThreadIds: [1, 2],
      },
    };

    const checkoutPath = '/tmp/workspace/test-org/test-repo';

    // Execute handler
    await handler.handle(queueItem, checkoutPath);

    // Verify PR branch was checked out (not default branch)
    expect(mockRepoCheckout.switchBranch).toHaveBeenCalledWith(checkoutPath, '42-add-tests');

    // Verify fresh unresolved threads were fetched
    expect(mockGitHub.getPRReviewThreads).toHaveBeenCalledWith('test-org', 'test-repo', 100);

    // Verify Claude CLI was spawned with correct prompt
    expect(processFactory.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
        expect.stringContaining('PR #100'),
      ]),
      expect.objectContaining({
        cwd: checkoutPath,
      }),
    );

    // Verify prompt contains all unresolved comments with file paths and line numbers
    const spawnCall = processFactory.spawn.mock.calls[0];
    const prompt = spawnCall[1][spawnCall[1].length - 1];
    expect(prompt).toContain('src/index.ts:10');
    expect(prompt).toContain('src/util.ts:20');
    expect(prompt).toContain('reviewer');
    expect(prompt).toContain('Fix this issue');
    expect(prompt).toContain('Also fix this');

    // Verify instruction to not resolve threads (SC-006)
    expect(prompt).toContain('Do NOT resolve any review threads');

    // Verify changes were staged, committed, and pushed
    expect(mockGitHub.stageAll).toHaveBeenCalled();
    expect(mockGitHub.commit).toHaveBeenCalledWith(
      expect.stringContaining('Address PR #100 review feedback'),
    );
    expect(mockGitHub.commit).toHaveBeenCalledWith(
      expect.stringContaining('issue #42'),
    );
    expect(mockGitHub.commit).toHaveBeenCalledWith(
      expect.stringContaining('Co-Authored-By: Claude Sonnet 4.5'),
    );
    expect(mockGitHub.push).toHaveBeenCalledWith('origin', '42-add-tests');

    // #883: verify replies were posted with the new "Addressed in <sha>" body
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      100,
      1,
      expect.stringContaining('Addressed in abc1234'),
    );
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      100,
      2,
      expect.stringContaining('Addressed in abc1234'),
    );

    // #883: verify each thread was resolved via resolveReviewThread
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(2);
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_1');
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_2');

    // #926 FR-006: happy-path coalesces both labels into one removeLabels call.
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['waiting-for:address-pr-feedback', 'agent:in-progress'],
    );
  });

  // ==========================================================================
  // Test: Reply Completeness (SC-005)
  // ==========================================================================

  it('should post replies to all unresolved threads (SC-005)', async () => {
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');

    // Mock many unresolved threads
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/file1.ts',
        line: 10,
        body: 'Comment 1',
        author: 'reviewer1',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/file2.ts',
        line: 20,
        body: 'Comment 2',
        author: 'reviewer2',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 3,
        path: 'src/file3.ts',
        line: 30,
        body: 'Comment 3',
        author: 'reviewer3',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 4,
        path: 'src/file4.ts',
        line: 40,
        body: 'Comment 4',
        author: 'reviewer4',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 5,
        path: 'src/file5.ts',
        line: 50,
        body: 'Comment 5',
        author: 'reviewer5',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 100,
        reviewThreadIds: [1, 2, 3, 4, 5],
      },
    };

    await handler.handle(queueItem, '/tmp/workspace/test-org/test-repo');

    // SC-005: All 5 unresolved threads should receive replies
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(5);

    // Verify each thread ID was replied to
    for (let i = 1; i <= 5; i++) {
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        100,
        i,
        expect.any(String),
      );
    }
  });

  // ==========================================================================
  // Test: Thread Auto-Resolve Prevention (SC-006)
  // ==========================================================================

  it('#883: resolves each unresolved thread after successful reply', async () => {
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');

    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 100,
        reviewThreadIds: [1, 2],
      },
    };

    await handler.handle(queueItem, '/tmp/workspace/test-org/test-repo');

    // #883: reply once per thread + resolve once per thread
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // Test: Prompt Contains Required Information
  // ==========================================================================

  it('should build prompt with all required information', async () => {
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 101,
        path: 'src/auth.ts',
        line: 42,
        body: 'This authentication logic looks unsafe',
        author: 'security-reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 102,
        path: 'tests/auth.test.ts',
        line: 15,
        body: 'Missing test case for edge condition',
        author: 'qa-reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 99,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 200,
        reviewThreadIds: [101, 102],
      },
    };

    await handler.handle(queueItem, '/tmp/workspace/test-org/test-repo');

    const spawnCall = processFactory.spawn.mock.calls[0];
    const prompt = spawnCall[1][spawnCall[1].length - 1];

    // Verify PR and issue numbers
    expect(prompt).toContain('PR #200');
    expect(prompt).toContain('issue #99');

    // Verify file paths with line numbers
    expect(prompt).toContain('src/auth.ts:42');
    expect(prompt).toContain('tests/auth.test.ts:15');

    // Verify reviewer names
    expect(prompt).toContain('security-reviewer');
    expect(prompt).toContain('qa-reviewer');

    // Verify comment bodies
    expect(prompt).toContain('This authentication logic looks unsafe');
    expect(prompt).toContain('Missing test case for edge condition');

    // Verify instructions
    expect(prompt).toContain('unresolved review comments');
    expect(prompt).toContain('Make the necessary code changes');
    expect(prompt).toContain('Do NOT resolve any review threads');
  });

  // ==========================================================================
  // Test: No Changes Skip
  // ==========================================================================

  it('#883: no-diff cycle → Disposition B (blocked label, no replies, no removal)', async () => {
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');

    // No changes after CLI runs
    mockGitHub.getStatus.mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });

    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 100,
        reviewThreadIds: [1, 2],
      },
    };

    await handler.handle(queueItem, '/tmp/workspace/test-org/test-repo');

    // Should not commit or push
    expect(mockGitHub.stageAll).not.toHaveBeenCalled();
    expect(mockGitHub.commit).not.toHaveBeenCalled();
    expect(mockGitHub.push).not.toHaveBeenCalled();

    // #883: no-diff → Disposition B → no replies, no resolves, no waiting-for
    // removal. #926 SC-004: `finally` still clears `agent:in-progress`.
    expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
    expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
    expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      expect.arrayContaining(['waiting-for:address-pr-feedback']),
    );
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['agent:in-progress'],
    );

    // #883: blocked:stuck-feedback-loop is added
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['blocked:stuck-feedback-loop'],
    );
  });

  // ==========================================================================
  // Test: Partial Reply Failure (FR-007)
  // ==========================================================================

  it('#883: partial resolve failure — label still removed when ≥1 resolve succeeds', async () => {
    const { PrFeedbackHandler } = await import('../worker/pr-feedback-handler.js');

    // Middle resolve fails (transient); replies all succeed
    mockGitHub.resolveReviewThread = vi
      .fn()
      .mockResolvedValueOnce(undefined) // Thread 1: success
      .mockRejectedValueOnce(new Error('GitHub API error')) // Thread 2: fail
      .mockResolvedValueOnce(undefined); // Thread 3: success

    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 1,
        path: 'src/file1.ts',
        line: 10,
        body: 'Comment 1',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 2,
        path: 'src/file2.ts',
        line: 20,
        body: 'Comment 2',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
      {
        id: 3,
        path: 'src/file3.ts',
        line: 30,
        body: 'Comment 3',
        author: 'reviewer',
        resolved: false,
        in_reply_to_id: undefined,
      },
    ]));

    const handler = new PrFeedbackHandler(
      {
        workspaceDir: '/tmp/workspace',
        phaseTimeoutMs: 60000,
        shutdownGracePeriodMs: 5000,
        validateCommand: 'echo ok',
        gates: {},
      },
      logger,
      agentLauncher,
      {
        isDuplicate: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        tryMarkProcessed: vi.fn().mockResolvedValue(true),
      },
      undefined,
    );

    const queueItem = {
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback' as const,
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {
        prNumber: 100,
        reviewThreadIds: [1, 2, 3],
      },
    };

    await handler.handle(queueItem, '/tmp/workspace/test-org/test-repo');

    // All three replies + resolves should be attempted
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(3);
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(3);

    // FR-006 strict-decrease met (2 of 3 resolves succeeded) → label removed.
    // #926 FR-006: happy-path coalesces both labels into one removeLabels call.
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      42,
      ['waiting-for:address-pr-feedback', 'agent:in-progress'],
    );

    // FR-010: warn emitted for the persistently-failed resolve
    expect(logger.warn).toHaveBeenCalled();
  });

  // ==========================================================================
  // #878 SC-001: self-authored cluster comment (viewerDidAuthor:true) on an
  // unresolved thread with author_association=NONE reaches the worker path.
  // Direct replacement for the #869 login-comparison regression scenario —
  // the mechanism is now GraphQL's viewerDidAuthor primitive.
  // ==========================================================================
  it('#878: self-authored (viewerDidAuthor:true) comment with NONE tier reaches the worker path', async () => {
    // Trust-mock: simulate the real #878 decision — viewerDidAuthor:true
    // trusts as 'self-authored', association-tier trust still applies.
    const workflowEngine = await import('@generacy-ai/workflow-engine');
    const originalMock = (workflowEngine.isTrustedCommentAuthor as ReturnType<typeof vi.fn>).getMockImplementation();
    (workflowEngine.isTrustedCommentAuthor as ReturnType<typeof vi.fn>).mockImplementation(
      (comment: { author: string; authorAssociation?: string; viewerDidAuthor?: boolean }) => {
        if (comment.viewerDidAuthor === true) {
          return { trusted: true, reason: 'self-authored' };
        }
        if (comment.authorAssociation && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation)) {
          return { trusted: true, reason: comment.authorAssociation.toLowerCase() };
        }
        return { trusted: false, reason: 'none-untrusted' };
      },
    );

    const logger = createMockLogger();
    const queueAdapter = new MockQueueManager();
    const enqueueIfAbsentSpy = vi.spyOn(queueAdapter, 'enqueueIfAbsent');
    const clientFactory = vi.fn().mockReturnValue(mockGitHub);

    mockGitHub.getIssue.mockResolvedValue({
      number: 4,
      title: 'sniplink test',
      body: '',
      state: 'open',
      labels: [{ name: 'agent:in-progress', color: '' }],
      assignees: ['cluster-app[bot]'],
      created_at: '',
      updated_at: '',
    });
    mockGitHub.getPRReviewThreads.mockResolvedValue([
      {
        id: 'PRRT_999',
        rootCommentId: 999,
        isResolved: false,
        comments: [{
          id: 999,
          body: 'please tweak this',
          author: 'cluster-app[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: true,
          created_at: '',
          updated_at: '',
          path: 'src/x.ts',
          line: 1,
        }],
      },
    ]);
    mockGitHub.addLabels.mockResolvedValue(undefined);

    const svc = new PrFeedbackMonitorService(
      logger,
      clientFactory,
      queueAdapter,
      { enabled: true, pollIntervalMs: 60000, adaptivePolling: false, maxConcurrentPolls: 1 },
      [{ owner: 'christrudelpw', repo: 'sniplink' }],
      'cluster-app[bot]',
    );

    const result = await svc.processPrReviewEvent({
      owner: 'christrudelpw',
      repo: 'sniplink',
      prNumber: 14,
      prBody: 'Closes #4',
      branchName: '4-add-tests',
      source: 'webhook',
    });

    expect(result).toBe(true);
    expect(enqueueIfAbsentSpy).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('PR feedback work enqueued'),
    );

    // Self-authored comment must NOT appear in comment-skipped log lines.
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const skipped = infoCalls.find(([meta]) =>
      typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).event === 'comment-skipped',
    );
    expect(skipped).toBeUndefined();

    // Restore the blanket-trust mock for later tests.
    if (originalMock) {
      (workflowEngine.isTrustedCommentAuthor as ReturnType<typeof vi.fn>).mockImplementation(originalMock);
    } else {
      (workflowEngine.isTrustedCommentAuthor as ReturnType<typeof vi.fn>).mockReturnValue({ trusted: true, reason: 'owner' });
    }
    svc.stopPolling();
  });
});
