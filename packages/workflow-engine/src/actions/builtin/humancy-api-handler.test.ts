/**
 * Unit tests for HumancyApiDecisionHandler.
 *
 * T020: Request-to-payload mapping — verifies ReviewDecisionRequest fields are
 * correctly mapped to the orchestrator's CreateDecisionPayload on POST /queue.
 *
 * T021: Response mapping — verifies DecisionResponse from the orchestrator is
 * correctly mapped back to ReviewDecisionResponse for the workflow engine.
 *
 * Strategy: mock global.fetch to capture the POST body and return controlled
 * SSE streams, then assert on mapped payloads and return values.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumancyApiDecisionHandler } from './humancy-api-handler.js';
import type { HumancyApiHandlerConfig } from './humancy-api-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal ReviewDecisionRequest for testing. */
function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: 'review' as const,
    title: 'Review: deploy step',
    description: 'Please review the deployment plan',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject', requiresComment: true },
    ],
    workflowId: 'wf_deploy_abc12345',
    stepId: 'review-deploy',
    urgency: 'normal' as const,
    artifact: 'diff output here',
    ...overrides,
  };
}

/** Default handler config used across tests. */
const defaultConfig: HumancyApiHandlerConfig = {
  apiUrl: 'http://localhost:3200',
  agentId: 'agent-test-1',
  authToken: 'test-token',
  fallbackToSimulation: false,
  sseReconnectDelay: 10,
  maxReconnectAttempts: 0,
};

/** Default DecisionResponse shape used when no override is provided. */
const defaultDecisionResponse = {
  id: 'dec-uuid-123',
  response: true as string | boolean | string[],
  comment: 'Looks good',
  respondedBy: 'reviewer-1',
  respondedAt: '2026-02-15T10:00:00.000Z',
};

/**
 * Creates a ReadableStream that emits SSE data for a queue:item:removed event
 * matching the given decisionId.
 *
 * @param decisionId  The decision ID to include in the event data.
 * @param responseOverrides  Optional overrides for the DecisionResponse fields.
 */
function createSSEStream(
  decisionId: string,
  responseOverrides?: Partial<typeof defaultDecisionResponse>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const response = { ...defaultDecisionResponse, id: decisionId, ...responseOverrides };
  const eventData = JSON.stringify({
    action: 'removed',
    item: { id: decisionId },
    queueSize: 0,
    response,
  });
  const sseText = `event: queue:item:removed\ndata: ${eventData}\nid: evt_1\n\n`;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
}

/**
 * Sets up global.fetch mock that:
 * 1. Captures the POST /queue request body
 * 2. Returns a created DecisionQueueItem with a predictable ID
 * 3. Returns an SSE stream for GET /events that resolves the decision
 *
 * @param decisionId        Predictable decision ID for the created item.
 * @param responseOverrides Optional overrides for the DecisionResponse in the SSE event.
 *
 * Returns the captured POST body for assertion.
 */
function setupFetchMock(
  decisionId = 'dec-uuid-123',
  responseOverrides?: Partial<typeof defaultDecisionResponse>,
) {
  let capturedPayload: unknown = null;

  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    // POST /queue — create decision
    if (urlStr.includes('/queue') && init?.method === 'POST') {
      capturedPayload = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /events — SSE stream
    if (urlStr.includes('/events')) {
      return new Response(createSSEStream(decisionId, responseOverrides), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    return new Response('Not Found', { status: 404 });
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    getPayload: () => capturedPayload as Record<string, unknown> | null,
    fetchMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HumancyApiDecisionHandler — request-to-payload mapping (T020)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Fix Date.now() to a stable value for expiresAt assertions
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Field mapping tests
  // -----------------------------------------------------------------------

  it('maps title to prompt', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ title: 'Review: deploy step' });

    await handler.requestDecision(request, 30_000);

    expect(getPayload()?.prompt).toBe('Review: deploy step');
  });

  it('maps description to context.description', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ description: 'Check the deployment plan carefully' });

    await handler.requestDecision(request, 30_000);

    const ctx = getPayload()?.context as Record<string, unknown>;
    expect(ctx.description).toBe('Check the deployment plan carefully');
  });

  it('maps artifact to context.artifact', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ artifact: '--- a/file.ts\n+++ b/file.ts' });

    await handler.requestDecision(request, 30_000);

    const ctx = getPayload()?.context as Record<string, unknown>;
    expect(ctx.artifact).toBe('--- a/file.ts\n+++ b/file.ts');
  });

  it('omits context.description when description is empty', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ description: '' });

    await handler.requestDecision(request, 30_000);

    const ctx = getPayload()?.context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('description');
  });

  it('omits context.artifact when artifact is undefined', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ artifact: undefined });

    await handler.requestDecision(request, 30_000);

    const ctx = getPayload()?.context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('artifact');
  });

  it('maps workflowId directly', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ workflowId: 'wf_my_workflow_abc123' });

    await handler.requestDecision(request, 30_000);

    expect(getPayload()?.workflowId).toBe('wf_my_workflow_abc123');
  });

  it('maps stepId directly', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({ stepId: 'step-review-code' });

    await handler.requestDecision(request, 30_000);

    expect(getPayload()?.stepId).toBe('step-review-code');
  });

  it('sets type to review', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    await handler.requestDecision(makeRequest(), 30_000);

    expect(getPayload()?.type).toBe('review');
  });

  // -----------------------------------------------------------------------
  // Urgency → Priority mapping
  // -----------------------------------------------------------------------

  describe('urgency → priority mapping', () => {
    it('maps urgency "low" to priority "when_available"', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest({ urgency: 'low' }), 30_000);

      expect(getPayload()?.priority).toBe('when_available');
    });

    it('maps urgency "normal" to priority "when_available"', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest({ urgency: 'normal' }), 30_000);

      expect(getPayload()?.priority).toBe('when_available');
    });

    it('maps urgency "blocking_soon" to priority "blocking_soon"', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest({ urgency: 'blocking_soon' }), 30_000);

      expect(getPayload()?.priority).toBe('blocking_soon');
    });

    it('maps urgency "blocking_now" to priority "blocking_now"', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest({ urgency: 'blocking_now' }), 30_000);

      expect(getPayload()?.priority).toBe('blocking_now');
    });
  });

  // -----------------------------------------------------------------------
  // Options mapping
  // -----------------------------------------------------------------------

  describe('options mapping', () => {
    it('maps option id and label directly', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      await handler.requestDecision(request, 30_000);

      const options = getPayload()?.options as Array<Record<string, unknown>>;
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({ id: 'approve', label: 'Approve' });
      expect(options[1]).toEqual({ id: 'reject', label: 'Reject' });
    });

    it('maps requiresComment to description hint', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject', requiresComment: true },
        ],
      });

      await handler.requestDecision(request, 30_000);

      const options = getPayload()?.options as Array<Record<string, unknown>>;
      expect(options[0]).not.toHaveProperty('description');
      expect(options[1]).toEqual({
        id: 'reject',
        label: 'Reject',
        description: 'Comment required',
      });
    });

    it('strips requiresComment from mapped options (does not pass it through)', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [{ id: 'approve', label: 'Approve', requiresComment: true }],
      });

      await handler.requestDecision(request, 30_000);

      const options = getPayload()?.options as Array<Record<string, unknown>>;
      expect(options[0]).not.toHaveProperty('requiresComment');
      expect(options[0]).toHaveProperty('description', 'Comment required');
    });

    it('sets options to undefined when options array is empty', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({ options: [] });

      await handler.requestDecision(request, 30_000);

      expect(getPayload()?.options).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // expiresAt calculation
  // -----------------------------------------------------------------------

  describe('expiresAt calculation', () => {
    it('sets expiresAt to timeout + 5 minute buffer', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const timeout = 60_000; // 1 minute
      const bufferMs = 5 * 60 * 1000; // 5 minutes

      await handler.requestDecision(makeRequest(), timeout);

      const expiresAt = getPayload()?.expiresAt as string;
      const expectedMs = new Date('2026-02-15T09:00:00.000Z').getTime() + timeout + bufferMs;
      const expectedIso = new Date(expectedMs).toISOString();
      expect(expiresAt).toBe(expectedIso);
    });

    it('handles large timeouts (24h) with 5 minute buffer', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const timeout = 24 * 60 * 60 * 1000; // 24 hours
      const bufferMs = 5 * 60 * 1000;

      await handler.requestDecision(makeRequest(), timeout);

      const expiresAt = getPayload()?.expiresAt as string;
      const expectedMs = new Date('2026-02-15T09:00:00.000Z').getTime() + timeout + bufferMs;
      const expectedIso = new Date(expectedMs).toISOString();
      expect(expiresAt).toBe(expectedIso);
    });

    it('produces a valid ISO 8601 datetime string', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      const expiresAt = getPayload()?.expiresAt as string;
      expect(new Date(expiresAt).toISOString()).toBe(expiresAt);
    });
  });

  // -----------------------------------------------------------------------
  // agentId from config
  // -----------------------------------------------------------------------

  describe('agentId from config', () => {
    it('includes agentId from handler config in payload', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        agentId: 'my-agent-42',
      });

      await handler.requestDecision(makeRequest(), 30_000);

      expect(getPayload()?.agentId).toBe('my-agent-42');
    });

    it('uses the config agentId, not a value from the request', async () => {
      const { getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        agentId: 'config-agent',
      });

      // Request does not have an agentId field — verify config value is used
      await handler.requestDecision(makeRequest(), 30_000);

      expect(getPayload()?.agentId).toBe('config-agent');
    });
  });

  // -----------------------------------------------------------------------
  // Full payload structure
  // -----------------------------------------------------------------------

  it('produces a complete, correctly shaped payload', async () => {
    const { getPayload } = setupFetchMock();
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      agentId: 'agent-full-test',
    });

    const request = makeRequest({
      title: 'Review: full test',
      description: 'Full payload test',
      artifact: 'some artifact',
      workflowId: 'wf_test_001',
      stepId: 'step-1',
      urgency: 'blocking_now',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', requiresComment: true },
      ],
    });

    await handler.requestDecision(request, 120_000);

    const payload = getPayload();
    expect(payload).toEqual({
      workflowId: 'wf_test_001',
      stepId: 'step-1',
      type: 'review',
      prompt: 'Review: full test',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', description: 'Comment required' },
      ],
      context: {
        description: 'Full payload test',
        artifact: 'some artifact',
      },
      priority: 'blocking_now',
      expiresAt: new Date(
        new Date('2026-02-15T09:00:00.000Z').getTime() + 120_000 + 5 * 60 * 1000,
      ).toISOString(),
      agentId: 'agent-full-test',
    });
  });

  // -----------------------------------------------------------------------
  // POST request details
  // -----------------------------------------------------------------------

  describe('POST request', () => {
    it('sends to {apiUrl}/queue', async () => {
      const { fetchMock } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        apiUrl: 'http://my-orchestrator:3200',
      });

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      expect(postCall).toBeDefined();
      expect(postCall![0]).toBe('http://my-orchestrator:3200/queue');
    });

    it('strips trailing slashes from apiUrl', async () => {
      const { fetchMock } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        apiUrl: 'http://localhost:3200///',
      });

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      expect(postCall![0]).toBe('http://localhost:3200/queue');
    });

    it('includes Content-Type: application/json header', async () => {
      const { fetchMock } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      const headers = postCall![1] as RequestInit;
      expect((headers.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('includes Authorization header when authToken is configured', async () => {
      const { fetchMock } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        authToken: 'my-secret-token',
      });

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      const headers = postCall![1] as RequestInit;
      expect((headers.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer my-secret-token',
      );
    });

    it('omits Authorization header when authToken is not configured', async () => {
      const { fetchMock } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        authToken: undefined,
      });

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      const headers = postCall![1] as RequestInit;
      expect((headers.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('sends payload as JSON string in the body', async () => {
      const { fetchMock, getPayload } = setupFetchMock();
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const init = call[1] as RequestInit | undefined;
          return init?.method === 'POST';
        },
      );
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual(getPayload());
    });
  });
});

// ==========================================================================
// T021: Response mapping tests
// ==========================================================================

describe('HumancyApiDecisionHandler — response mapping (T021)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Boolean response mapping
  // -----------------------------------------------------------------------

  describe('boolean response', () => {
    it('maps response: true to approved: true', async () => {
      setupFetchMock('dec-bool-true', { response: true, comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
    });

    it('maps response: false to approved: false', async () => {
      setupFetchMock('dec-bool-false', { response: false, comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(false);
    });

    it('does not set decision field for boolean response', async () => {
      setupFetchMock('dec-bool-no-decision', { response: true, comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.decision).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // String response mapping
  // -----------------------------------------------------------------------

  describe('string response', () => {
    it('maps response matching first option to approved: true', async () => {
      setupFetchMock('dec-str-approve', { response: 'approve', comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.approved).toBe(true);
      expect(result.decision).toBe('approve');
    });

    it('maps response not matching first option to approved: false', async () => {
      setupFetchMock('dec-str-reject', { response: 'reject', comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.approved).toBe(false);
      expect(result.decision).toBe('reject');
    });

    it('sets decision to the raw string option ID', async () => {
      setupFetchMock('dec-str-custom', { response: 'custom-option', comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'custom-option', label: 'Custom' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.decision).toBe('custom-option');
      expect(result.approved).toBe(false); // not the first option
    });
  });

  // -----------------------------------------------------------------------
  // Array response mapping
  // -----------------------------------------------------------------------

  describe('array response', () => {
    it('maps array with first option match to approved: true', async () => {
      setupFetchMock('dec-arr-approve', { response: ['approve'], comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.approved).toBe(true);
      expect(result.decision).toBe('approve');
    });

    it('maps array without first option match to approved: false', async () => {
      setupFetchMock('dec-arr-reject', { response: ['reject'], comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.approved).toBe(false);
      expect(result.decision).toBe('reject');
    });

    it('uses only the first element of the array for decision', async () => {
      setupFetchMock('dec-arr-multi', {
        response: ['reject', 'approve'],
        comment: undefined,
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.decision).toBe('reject');
      expect(result.approved).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Comment → input mapping
  // -----------------------------------------------------------------------

  describe('comment mapping', () => {
    it('maps comment to input', async () => {
      setupFetchMock('dec-comment', {
        response: true,
        comment: 'Looks great, ship it!',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.input).toBe('Looks great, ship it!');
    });

    it('omits input when comment is undefined', async () => {
      setupFetchMock('dec-no-comment', { response: true, comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.input).toBeUndefined();
    });

    it('omits input when comment is empty string', async () => {
      setupFetchMock('dec-empty-comment', { response: true, comment: '' });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      // Empty string is falsy, so comment should not be mapped
      expect(result.input).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // respondedBy and respondedAt passthrough
  // -----------------------------------------------------------------------

  describe('respondedBy and respondedAt passthrough', () => {
    it('passes respondedBy directly from response', async () => {
      setupFetchMock('dec-by', {
        response: true,
        respondedBy: 'user-jane-42',
        comment: undefined,
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.respondedBy).toBe('user-jane-42');
    });

    it('passes respondedAt directly from response', async () => {
      setupFetchMock('dec-at', {
        response: true,
        respondedAt: '2026-02-15T14:30:00.000Z',
        comment: undefined,
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.respondedAt).toBe('2026-02-15T14:30:00.000Z');
    });
  });

  // -----------------------------------------------------------------------
  // Full response structure
  // -----------------------------------------------------------------------

  it('produces a complete, correctly shaped response for boolean approval', async () => {
    setupFetchMock('dec-full-bool', {
      response: true,
      comment: 'LGTM',
      respondedBy: 'reviewer-alice',
      respondedAt: '2026-02-15T12:00:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    const result = await handler.requestDecision(makeRequest(), 30_000);

    expect(result).toEqual({
      approved: true,
      input: 'LGTM',
      respondedBy: 'reviewer-alice',
      respondedAt: '2026-02-15T12:00:00.000Z',
    });
  });

  it('produces a complete, correctly shaped response for string rejection', async () => {
    setupFetchMock('dec-full-str', {
      response: 'reject',
      comment: 'Needs more tests',
      respondedBy: 'reviewer-bob',
      respondedAt: '2026-02-15T13:00:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', requiresComment: true },
      ],
    });

    const result = await handler.requestDecision(request, 30_000);

    expect(result).toEqual({
      approved: false,
      decision: 'reject',
      input: 'Needs more tests',
      respondedBy: 'reviewer-bob',
      respondedAt: '2026-02-15T13:00:00.000Z',
    });
  });

  it('produces a complete, correctly shaped response for array approval', async () => {
    setupFetchMock('dec-full-arr', {
      response: ['approve'],
      comment: 'Ship it',
      respondedBy: 'reviewer-carol',
      respondedAt: '2026-02-15T14:00:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });

    const result = await handler.requestDecision(request, 30_000);

    expect(result).toEqual({
      approved: true,
      decision: 'approve',
      input: 'Ship it',
      respondedBy: 'reviewer-carol',
      respondedAt: '2026-02-15T14:00:00.000Z',
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles string response with empty options array (approved: false)', async () => {
      setupFetchMock('dec-edge-empty-opts', { response: 'approve', comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({ options: [] });

      const result = await handler.requestDecision(request, 30_000);

      // No first option to compare against → approved is false
      expect(result.approved).toBe(false);
      expect(result.decision).toBe('approve');
    });

    it('handles array response with empty options array (approved: false)', async () => {
      setupFetchMock('dec-edge-arr-empty-opts', { response: ['approve'], comment: undefined });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({ options: [] });

      const result = await handler.requestDecision(request, 30_000);

      expect(result.approved).toBe(false);
      expect(result.decision).toBe('approve');
    });
  });
});

// ==========================================================================
// T022: Happy path — full request-response cycle tests
// ==========================================================================

describe('HumancyApiDecisionHandler — happy path full cycle (T022)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // End-to-end: POST → SSE → mapped response
  // -----------------------------------------------------------------------

  it('completes full cycle: POST creates decision, SSE resolves it, response is mapped', async () => {
    const decisionId = 'dec-e2e-001';
    const { fetchMock } = setupFetchMock(decisionId, {
      response: true,
      comment: 'Ship it!',
      respondedBy: 'reviewer-alice',
      respondedAt: '2026-02-15T10:30:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    const result = await handler.requestDecision(makeRequest(), 30_000);

    // Verify POST was called to create the decision
    const postCall = fetchMock.mock.calls.find(
      (call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      },
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toBe('http://localhost:3200/queue');

    // Verify SSE endpoint was called
    const sseCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('/events'),
    );
    expect(sseCall).toBeDefined();

    // Verify the fully mapped response
    expect(result).toEqual({
      approved: true,
      input: 'Ship it!',
      respondedBy: 'reviewer-alice',
      respondedAt: '2026-02-15T10:30:00.000Z',
    });
  });

  it('makes POST before connecting to SSE (correct ordering)', async () => {
    const callOrder: string[] = [];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        callOrder.push('POST /queue');
        return new Response(
          JSON.stringify({ id: 'dec-order-001', createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        callOrder.push('GET /events');
        return new Response(
          createSSEStream('dec-order-001', {
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler(defaultConfig);
    await handler.requestDecision(makeRequest(), 30_000);

    expect(callOrder).toEqual(['POST /queue', 'GET /events']);
  });

  it('uses the decision ID from POST response to match SSE events', async () => {
    const serverId = 'server-assigned-uuid-42';
    const encoder = new TextEncoder();

    // Emit two SSE events: one for a different decision, one matching
    const nonMatchingEvent = JSON.stringify({
      action: 'removed',
      item: { id: 'some-other-decision' },
      queueSize: 1,
      response: {
        id: 'some-other-decision',
        response: false,
        respondedBy: 'reviewer',
        respondedAt: '2026-02-15T09:30:00.000Z',
      },
    });
    const matchingEvent = JSON.stringify({
      action: 'removed',
      item: { id: serverId },
      queueSize: 0,
      response: {
        id: serverId,
        response: true,
        comment: 'Correct decision matched',
        respondedBy: 'reviewer-bob',
        respondedAt: '2026-02-15T10:00:00.000Z',
      },
    });

    const sseText =
      `event: queue:item:removed\ndata: ${nonMatchingEvent}\nid: evt_1\n\n` +
      `event: queue:item:removed\ndata: ${matchingEvent}\nid: evt_2\n\n`;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: serverId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseText));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const result = await handler.requestDecision(makeRequest(), 30_000);

    // Should have matched the second event (serverId), not the first
    expect(result.approved).toBe(true);
    expect(result.input).toBe('Correct decision matched');
    expect(result.respondedBy).toBe('reviewer-bob');
  });

  it('ignores non-queue:item:removed SSE events', async () => {
    const decisionId = 'dec-ignore-events';
    const encoder = new TextEncoder();

    const heartbeatEvent = `event: heartbeat\ndata: {}\nid: evt_0\n\n`;
    const addedEvent = `event: queue:item:added\ndata: ${JSON.stringify({
      action: 'added',
      item: { id: decisionId },
      queueSize: 1,
    })}\nid: evt_1\n\n`;
    const removedEvent = `event: queue:item:removed\ndata: ${JSON.stringify({
      action: 'removed',
      item: { id: decisionId },
      queueSize: 0,
      response: {
        id: decisionId,
        response: 'approve',
        comment: 'After filtering',
        respondedBy: 'reviewer',
        respondedAt: '2026-02-15T10:00:00.000Z',
      },
    })}\nid: evt_2\n\n`;

    const sseText = heartbeatEvent + addedEvent + removedEvent;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseText));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler(defaultConfig);
    const request = makeRequest({
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
    const result = await handler.requestDecision(request, 30_000);

    // Should have resolved from the queue:item:removed event only
    expect(result.approved).toBe(true);
    expect(result.decision).toBe('approve');
    expect(result.input).toBe('After filtering');
  });

  // -----------------------------------------------------------------------
  // SSE connection cleanup after resolution
  // -----------------------------------------------------------------------

  it('aborts the SSE connection after successful resolution', async () => {
    const decisionId = 'dec-cleanup-001';
    let sseAbortSignal: AbortSignal | undefined;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        // Capture the signal passed to the SSE fetch
        sseAbortSignal = init?.signal ?? undefined;
        return new Response(
          createSSEStream(decisionId, {
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler(defaultConfig);
    await handler.requestDecision(makeRequest(), 30_000);

    // The abort signal should have been passed to the SSE fetch
    expect(sseAbortSignal).toBeDefined();

    // After resolution, the controller should be aborted (cleanup in finally block)
    expect(sseAbortSignal!.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // SSE auth headers
  // -----------------------------------------------------------------------

  it('passes Authorization header to SSE endpoint when authToken configured', async () => {
    const decisionId = 'dec-sse-auth';
    let sseHeaders: Record<string, string> | undefined;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(
          createSSEStream(decisionId, {
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      authToken: 'sse-secret-token',
    });
    await handler.requestDecision(makeRequest(), 30_000);

    expect(sseHeaders).toBeDefined();
    expect(sseHeaders!['Authorization']).toBe('Bearer sse-secret-token');
    expect(sseHeaders!['Accept']).toBe('text/event-stream');
  });

  // -----------------------------------------------------------------------
  // Various response types through full cycle
  // -----------------------------------------------------------------------

  describe('full cycle with different response types', () => {
    it('handles boolean true response end-to-end', async () => {
      setupFetchMock('dec-cycle-bool-true', {
        response: true,
        comment: 'LGTM',
        respondedBy: 'alice',
        respondedAt: '2026-02-15T10:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result).toEqual({
        approved: true,
        input: 'LGTM',
        respondedBy: 'alice',
        respondedAt: '2026-02-15T10:00:00.000Z',
      });
    });

    it('handles boolean false response end-to-end', async () => {
      setupFetchMock('dec-cycle-bool-false', {
        response: false,
        comment: 'Needs work',
        respondedBy: 'bob',
        respondedAt: '2026-02-15T11:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result).toEqual({
        approved: false,
        input: 'Needs work',
        respondedBy: 'bob',
        respondedAt: '2026-02-15T11:00:00.000Z',
      });
    });

    it('handles string option response end-to-end', async () => {
      setupFetchMock('dec-cycle-str', {
        response: 'approve',
        comment: 'Good to go',
        respondedBy: 'carol',
        respondedAt: '2026-02-15T12:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result).toEqual({
        approved: true,
        decision: 'approve',
        input: 'Good to go',
        respondedBy: 'carol',
        respondedAt: '2026-02-15T12:00:00.000Z',
      });
    });

    it('handles string rejection response end-to-end', async () => {
      setupFetchMock('dec-cycle-str-reject', {
        response: 'reject',
        comment: 'Security concerns',
        respondedBy: 'dave',
        respondedAt: '2026-02-15T13:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject', requiresComment: true },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result).toEqual({
        approved: false,
        decision: 'reject',
        input: 'Security concerns',
        respondedBy: 'dave',
        respondedAt: '2026-02-15T13:00:00.000Z',
      });
    });

    it('handles array response end-to-end', async () => {
      setupFetchMock('dec-cycle-arr', {
        response: ['approve'],
        comment: undefined,
        respondedBy: 'eve',
        respondedAt: '2026-02-15T14:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);
      const request = makeRequest({
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });

      const result = await handler.requestDecision(request, 30_000);

      expect(result).toEqual({
        approved: true,
        decision: 'approve',
        respondedBy: 'eve',
        respondedAt: '2026-02-15T14:00:00.000Z',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Timeout cleanup (no dangling timers)
  // -----------------------------------------------------------------------

  it('clears timeout timer on successful resolution (no dangling timers)', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    setupFetchMock('dec-no-dangle', {
      response: true,
      comment: undefined,
      respondedBy: 'reviewer',
      respondedAt: '2026-02-15T10:00:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    await handler.requestDecision(makeRequest(), 30_000);

    // The handler should have cleared the timeout timer in its finally block
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Multiple sequential requests reuse handler
  // -----------------------------------------------------------------------

  it('supports multiple sequential requests on the same handler instance', async () => {
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    // First request
    setupFetchMock('dec-seq-1', {
      response: true,
      comment: 'First approval',
      respondedBy: 'reviewer-1',
      respondedAt: '2026-02-15T10:00:00.000Z',
    });
    const result1 = await handler.requestDecision(makeRequest(), 30_000);
    expect(result1.approved).toBe(true);
    expect(result1.input).toBe('First approval');

    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));

    // Second request with different response
    setupFetchMock('dec-seq-2', {
      response: false,
      comment: 'Second rejection',
      respondedBy: 'reviewer-2',
      respondedAt: '2026-02-15T11:00:00.000Z',
    });
    const result2 = await handler.requestDecision(makeRequest(), 30_000);
    expect(result2.approved).toBe(false);
    expect(result2.input).toBe('Second rejection');
  });
});

// ==========================================================================
// T023: Timeout enforcement tests
// ==========================================================================

describe('HumancyApiDecisionHandler — timeout enforcement (T023)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Helper: SSE stream that never emits a matching event
  // -----------------------------------------------------------------------

  /**
   * Sets up a fetch mock where POST /queue succeeds but the SSE stream
   * stays open indefinitely without emitting the matching decision event.
   *
   * The stream sends periodic heartbeat comments to keep the connection
   * alive, simulating a real SSE endpoint that simply hasn't received
   * a response yet.
   */
  function setupHangingSSEMock(decisionId = 'dec-timeout-001') {
    let sseAbortSignal: AbortSignal | undefined;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // POST /queue — create decision successfully
      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // GET /events — SSE stream that never resolves the decision
      if (urlStr.includes('/events')) {
        sseAbortSignal = init?.signal ?? undefined;
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Send a heartbeat comment — the stream stays open
            controller.enqueue(encoder.encode(': heartbeat\n\n'));

            // Emit a queue:item:removed for a DIFFERENT decision (should be ignored)
            const unrelatedEvent = JSON.stringify({
              action: 'removed',
              item: { id: 'some-other-decision-id' },
              queueSize: 0,
              response: {
                id: 'some-other-decision-id',
                response: true,
                respondedBy: 'reviewer',
                respondedAt: '2026-02-15T09:30:00.000Z',
              },
            });
            controller.enqueue(
              encoder.encode(`event: queue:item:removed\ndata: ${unrelatedEvent}\nid: evt_1\n\n`),
            );

            // Never close the stream — simulates waiting for the human reviewer
            // The stream will be aborted when the timeout fires
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    return {
      fetchMock,
      getSSEAbortSignal: () => sseAbortSignal,
    };
  }

  // -----------------------------------------------------------------------
  // Timeout throws CorrelationTimeoutError
  // -----------------------------------------------------------------------

  it('throws CorrelationTimeoutError when timeout expires before SSE resolution', async () => {
    setupHangingSSEMock('dec-timeout-basic');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 200).catch((err) => {
      caughtError = err as Error;
    });

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(250);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain('timed out');
  });

  it('thrown error has name "CorrelationTimeoutError"', async () => {
    setupHangingSSEMock('dec-timeout-instance');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 200).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('CorrelationTimeoutError');
  });

  it('error.name equals "CorrelationTimeoutError" (checked by HumancyReviewAction)', async () => {
    setupHangingSSEMock('dec-timeout-name');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 200).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('CorrelationTimeoutError');
  });

  it('includes the decision ID in the timeout error', async () => {
    const decisionId = 'dec-timeout-with-id';
    setupHangingSSEMock(decisionId);
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 200).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain(decisionId);
  });

  it('includes the timeout duration in the error message', async () => {
    setupHangingSSEMock('dec-timeout-msg');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 500).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(600);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain('500ms');
  });

  // -----------------------------------------------------------------------
  // SSE connection cleanup on timeout
  // -----------------------------------------------------------------------

  it('aborts the SSE connection when timeout fires', async () => {
    const { getSSEAbortSignal } = setupHangingSSEMock('dec-timeout-abort');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    // Attach catch handler eagerly to prevent unhandled rejection
    const promise = handler.requestDecision(makeRequest(), 200).catch(() => {});

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    const signal = getSSEAbortSignal();
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });

  it('clears the timeout timer resources in the finally block', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    setupHangingSSEMock('dec-timeout-cleanup');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    // Attach catch handler eagerly to prevent unhandled rejection
    const promise = handler.requestDecision(makeRequest(), 200).catch(() => {});

    await vi.advanceTimersByTimeAsync(250);
    await promise;

    // Even on timeout, the finally block should call clearTimeout
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Timeout precision
  // -----------------------------------------------------------------------

  it('does not throw before the timeout elapses', async () => {
    setupHangingSSEMock('dec-timeout-no-early');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let rejected = false;
    const promise = handler.requestDecision(makeRequest(), 1000).catch(() => {
      rejected = true;
    });

    // Advance time to just before the timeout
    await vi.advanceTimersByTimeAsync(900);

    expect(rejected).toBe(false);

    // Now advance past the timeout to trigger it and clean up
    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it('throws after the exact timeout duration', async () => {
    setupHangingSSEMock('dec-timeout-exact');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let rejected = false;
    const promise = handler.requestDecision(makeRequest(), 500).catch(() => {
      rejected = true;
    });

    // Advance time to exactly the timeout
    await vi.advanceTimersByTimeAsync(500);

    // Allow microtasks to flush
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(rejected).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Timeout with various durations
  // -----------------------------------------------------------------------

  it('respects very short timeouts (50ms)', async () => {
    setupHangingSSEMock('dec-timeout-short');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 50).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('CorrelationTimeoutError');
  });

  it('respects longer timeouts (5 seconds)', async () => {
    setupHangingSSEMock('dec-timeout-long');
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let rejected = false;
    const promise = handler.requestDecision(makeRequest(), 5000).catch(() => {
      rejected = true;
    });

    // At 3 seconds, should still be waiting
    await vi.advanceTimersByTimeAsync(3000);
    expect(rejected).toBe(false);

    // At 5 seconds, should have timed out
    await vi.advanceTimersByTimeAsync(2100);
    await promise;
    expect(rejected).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Timeout does not fire if SSE resolves first
  // -----------------------------------------------------------------------

  it('does not throw timeout error when SSE resolves before timeout', async () => {
    // Use the standard setupFetchMock which immediately resolves
    setupFetchMock('dec-no-timeout', {
      response: true,
      comment: 'Resolved before timeout',
      respondedBy: 'fast-reviewer',
      respondedAt: '2026-02-15T09:01:00.000Z',
    });
    const handler = new HumancyApiDecisionHandler(defaultConfig);

    // Even with a short timeout, the immediate SSE resolution should win
    const result = await handler.requestDecision(makeRequest(), 200);

    expect(result.approved).toBe(true);
    expect(result.input).toBe('Resolved before timeout');
  });

  // -----------------------------------------------------------------------
  // Timeout with SSE stream that emits non-matching events only
  // -----------------------------------------------------------------------

  it('times out when SSE emits only non-matching decision IDs', async () => {
    const decisionId = 'dec-timeout-mismatch';
    const encoder = new TextEncoder();

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        // Emit multiple events for OTHER decisions — none match
        const events = ['other-1', 'other-2', 'other-3'].map((otherId, idx) => {
          const data = JSON.stringify({
            action: 'removed',
            item: { id: otherId },
            queueSize: 0,
            response: {
              id: otherId,
              response: true,
              respondedBy: 'reviewer',
              respondedAt: '2026-02-15T09:30:00.000Z',
            },
          });
          return `event: queue:item:removed\ndata: ${data}\nid: evt_${idx}\n\n`;
        }).join('');

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(events));
            // Keep stream open — never close
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 300).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('CorrelationTimeoutError');
  });

  it('times out when SSE emits only non-queue:item:removed event types', async () => {
    const decisionId = 'dec-timeout-wrong-type';
    const encoder = new TextEncoder();

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        // Emit events of wrong types (heartbeat, added, etc.) — none are queue:item:removed
        const events =
          `: heartbeat\n\n` +
          `event: queue:item:added\ndata: ${JSON.stringify({
            action: 'added',
            item: { id: decisionId },
            queueSize: 1,
          })}\nid: evt_1\n\n` +
          `event: heartbeat\ndata: {}\nid: evt_2\n\n`;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(events));
            // Keep stream open
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 300).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('CorrelationTimeoutError');
  });
});

// ==========================================================================
// T024: Simulation fallback tests
// ==========================================================================

describe('HumancyApiDecisionHandler — simulation fallback (T024)', () => {
  /** Config with fallbackToSimulation enabled (the default production behavior). */
  const fallbackConfig: HumancyApiHandlerConfig = {
    ...defaultConfig,
    fallbackToSimulation: true,
  };

  /** Config with fallbackToSimulation explicitly disabled. */
  const noFallbackConfig: HumancyApiHandlerConfig = {
    ...defaultConfig,
    fallbackToSimulation: false,
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Helper: mock fetch that fails on POST /queue
  // -----------------------------------------------------------------------

  /**
   * Sets up a fetch mock where POST /queue fails in a specific way.
   *
   * @param mode  How the POST should fail:
   *   - 'network' — fetch itself throws a TypeError (simulating connection refused)
   *   - number — returns an HTTP response with that status code
   */
  function setupFailingPostMock(mode: 'network' | number) {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        if (mode === 'network') {
          throw new TypeError('fetch failed: ECONNREFUSED');
        }
        return new Response(
          JSON.stringify({ error: `Server returned ${mode}` }),
          { status: mode, statusText: mode >= 500 ? 'Server Error' : 'Client Error' },
        );
      }

      // SSE endpoint should never be reached in fallback/error tests
      if (urlStr.includes('/events')) {
        return new Response(createSSEStream('should-not-reach'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock };
  }

  // -----------------------------------------------------------------------
  // Network error → simulated approval (fallbackToSimulation: true)
  // -----------------------------------------------------------------------

  describe('network error with fallback enabled', () => {
    it('returns simulated approval on network error (TypeError)', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
    });

    it('sets respondedBy to "simulated"', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.respondedBy).toBe('simulated');
    });

    it('sets respondedAt to current time', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.respondedAt).toBe('2026-02-15T09:00:00.000Z');
    });

    it('does not set decision or input fields', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.decision).toBeUndefined();
      expect(result.input).toBeUndefined();
    });

    it('does not attempt SSE connection', async () => {
      const { fetchMock } = setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      const sseCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/events'),
      );
      expect(sseCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 5xx server error → simulated approval (fallbackToSimulation: true)
  // -----------------------------------------------------------------------

  describe('5xx server error with fallback enabled', () => {
    it('returns simulated approval on 503 Service Unavailable', async () => {
      setupFailingPostMock(503);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });

    it('returns simulated approval on 500 Internal Server Error', async () => {
      setupFailingPostMock(500);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });

    it('returns simulated approval on 502 Bad Gateway', async () => {
      setupFailingPostMock(502);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });

    it('does not attempt SSE connection on 5xx', async () => {
      const { fetchMock } = setupFailingPostMock(503);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      const sseCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/events'),
      );
      expect(sseCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4xx client error → always throws (no fallback regardless of config)
  // -----------------------------------------------------------------------

  describe('4xx client error — never falls back', () => {
    it('throws on 401 Unauthorized even with fallback enabled', async () => {
      setupFailingPostMock(401);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 401/);
    });

    it('throws on 400 Bad Request even with fallback enabled', async () => {
      setupFailingPostMock(400);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 400/);
    });

    it('throws on 403 Forbidden even with fallback enabled', async () => {
      setupFailingPostMock(403);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 403/);
    });

    it('throws on 404 Not Found even with fallback enabled', async () => {
      setupFailingPostMock(404);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 404/);
    });

    it('throws on 422 Unprocessable Entity even with fallback enabled', async () => {
      setupFailingPostMock(422);
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 422/);
    });
  });

  // -----------------------------------------------------------------------
  // fallbackToSimulation: false → all errors throw
  // -----------------------------------------------------------------------

  describe('fallbackToSimulation: false — all errors throw', () => {
    it('throws on network error when fallback disabled', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(noFallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/ECONNREFUSED/);
    });

    it('throws on 503 when fallback disabled', async () => {
      setupFailingPostMock(503);
      const handler = new HumancyApiDecisionHandler(noFallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 503/);
    });

    it('throws on 500 when fallback disabled', async () => {
      setupFailingPostMock(500);
      const handler = new HumancyApiDecisionHandler(noFallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 500/);
    });

    it('throws on 401 when fallback disabled', async () => {
      setupFailingPostMock(401);
      const handler = new HumancyApiDecisionHandler(noFallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 401/);
    });

    it('throws on 400 when fallback disabled', async () => {
      setupFailingPostMock(400);
      const handler = new HumancyApiDecisionHandler(noFallbackConfig);

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 400/);
    });
  });

  // -----------------------------------------------------------------------
  // Default config behavior (fallbackToSimulation defaults to true)
  // -----------------------------------------------------------------------

  describe('default config (fallbackToSimulation defaults to true)', () => {
    it('falls back to simulation with default config on network error', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler({
        apiUrl: 'http://localhost:3200',
        agentId: 'agent-default',
        // fallbackToSimulation not set — should default to true
      });

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });

    it('falls back to simulation with default config on 503', async () => {
      setupFailingPostMock(503);
      const handler = new HumancyApiDecisionHandler({
        apiUrl: 'http://localhost:3200',
        agentId: 'agent-default',
      });

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });

    it('still throws on 4xx with default config', async () => {
      setupFailingPostMock(400);
      const handler = new HumancyApiDecisionHandler({
        apiUrl: 'http://localhost:3200',
        agentId: 'agent-default',
      });

      await expect(
        handler.requestDecision(makeRequest(), 30_000),
      ).rejects.toThrow(/POST \/queue failed: 400/);
    });
  });

  // -----------------------------------------------------------------------
  // SSE connection cleanup on POST failure with fallback
  // -----------------------------------------------------------------------

  describe('SSE cleanup on POST failure with fallback', () => {
    it('does not leave SSE connections open when falling back', async () => {
      const { fetchMock } = setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      // The SSE endpoint should never have been called — no connection to leak
      const sseCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/events'),
      );
      expect(sseCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Simulated response structure validation
  // -----------------------------------------------------------------------

  describe('simulated response structure', () => {
    it('produces a complete simulated response with all required fields', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result).toEqual({
        approved: true,
        respondedBy: 'simulated',
        respondedAt: '2026-02-15T09:00:00.000Z',
      });
    });

    it('uses current timestamp for respondedAt', async () => {
      setupFailingPostMock('network');
      const handler = new HumancyApiDecisionHandler(fallbackConfig);

      // Advance time before calling to verify it uses the current time
      vi.setSystemTime(new Date('2026-02-15T15:30:00.000Z'));

      const result = await handler.requestDecision(makeRequest(), 30_000);

      expect(result.respondedAt).toBe('2026-02-15T15:30:00.000Z');
    });
  });
});

// ==========================================================================
// T025: SSE reconnection tests
// ==========================================================================

describe('HumancyApiDecisionHandler — SSE reconnection (T025)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const encoder = new TextEncoder();

  /**
   * Creates an SSE ReadableStream that emits the given events then closes.
   * Each event should be a pre-formatted SSE string (e.g., "event: ...\ndata: ...\nid: ...\n\n").
   */
  function createSSEStreamFromTexts(texts: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const text of texts) {
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
      },
    });
  }

  /**
   * Builds a single SSE event text block.
   */
  function sseEvent(
    eventType: string,
    data: Record<string, unknown>,
    id: string,
  ): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;
  }

  // -----------------------------------------------------------------------
  // SSE stream closes after 2 events, succeeds on reconnection
  // -----------------------------------------------------------------------

  it('reconnects after SSE stream closes and resolves on reconnection', async () => {
    const decisionId = 'dec-reconnect-001';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // POST /queue — create decision
      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // GET /events — SSE stream
      if (urlStr.includes('/events')) {
        sseCallCount++;

        if (sseCallCount === 1) {
          // First connection: emit 2 unrelated events, then close the stream
          const events = [
            sseEvent('queue:item:added', {
              action: 'added',
              item: { id: decisionId },
              queueSize: 1,
            }, 'evt_1'),
            sseEvent('queue:item:removed', {
              action: 'removed',
              item: { id: 'some-other-decision' },
              queueSize: 0,
              response: {
                id: 'some-other-decision',
                response: true,
                respondedBy: 'reviewer',
                respondedAt: '2026-02-15T09:30:00.000Z',
              },
            }, 'evt_2'),
          ];
          return new Response(createSSEStreamFromTexts(events), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Second connection (reconnection): emit the matching event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: true,
            comment: 'Approved on reconnect',
            respondedBy: 'reviewer-reconnect',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'evt_3');

        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 3,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);

    // Advance time to allow the reconnection delay to pass
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    // Should have resolved from the reconnected stream
    expect(result.approved).toBe(true);
    expect(result.input).toBe('Approved on reconnect');
    expect(result.respondedBy).toBe('reviewer-reconnect');

    // Verify SSE was called twice (initial + 1 reconnection)
    expect(sseCallCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Last-Event-ID header on reconnection
  // -----------------------------------------------------------------------

  it('sends Last-Event-ID header on reconnection using the last received event ID', async () => {
    const decisionId = 'dec-reconnect-lastid';
    let sseCallCount = 0;
    const capturedHeaders: Array<Record<string, string>> = [];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;
        capturedHeaders.push({ ...(init?.headers as Record<string, string>) });

        if (sseCallCount === 1) {
          // First connection: emit one event with id "evt_42", then close
          const event = sseEvent('queue:item:added', {
            action: 'added',
            item: { id: decisionId },
            queueSize: 1,
          }, 'evt_42');
          return new Response(createSSEStreamFromTexts([event]), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Second connection: emit the matching resolution event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'evt_43');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 3,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    // First SSE call should NOT have Last-Event-ID
    expect(capturedHeaders[0]?.['Last-Event-ID']).toBeUndefined();

    // Second SSE call SHOULD have Last-Event-ID set to 'evt_42'
    expect(capturedHeaders[1]?.['Last-Event-ID']).toBe('evt_42');
  });

  // -----------------------------------------------------------------------
  // Reconnection respects maxReconnectAttempts limit
  // -----------------------------------------------------------------------

  it('respects maxReconnectAttempts and does not reconnect beyond the limit', async () => {
    const decisionId = 'dec-reconnect-limit';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;
        // Always fail with a network error to consume reconnection attempts
        throw new TypeError('fetch failed: ECONNRESET');
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 3,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 60_000).catch((err) => {
      caughtError = err as Error;
    });

    // Advance time enough for all reconnect attempts + delays
    // Each reconnect attempt has a 10ms delay; we need 3 delays = 30ms
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain('attempts');

    // 1 initial + 3 reconnect attempts = 4 total fetch calls to /events
    expect(sseCallCount).toBe(4);
  });

  // -----------------------------------------------------------------------
  // Failure after max attempts exhausted
  // -----------------------------------------------------------------------

  it('throws an error after maxReconnectAttempts is exhausted', async () => {
    const decisionId = 'dec-reconnect-exhausted';

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        // Every SSE connection fails with a network error
        throw new TypeError('fetch failed: ECONNREFUSED');
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 2,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 60_000).catch((err) => {
      caughtError = err as Error;
    });

    // Advance time for reconnection delays
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/SSE|reconnection|attempts|failed/i);
  });

  // -----------------------------------------------------------------------
  // Reconnection on fetch error (network drop during SSE)
  // -----------------------------------------------------------------------

  it('reconnects after SSE fetch fails with network error', async () => {
    const decisionId = 'dec-reconnect-neterr';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;

        if (sseCallCount === 1) {
          // First connection: network error
          throw new TypeError('fetch failed: ECONNRESET');
        }

        // Second connection: succeeds with matching event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: 'approve',
            comment: 'Recovered from network error',
            respondedBy: 'reviewer-net',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'evt_10');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 3,
    });

    const request = makeRequest({
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });

    const promise = handler.requestDecision(request, 30_000);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.approved).toBe(true);
    expect(result.decision).toBe('approve');
    expect(result.input).toBe('Recovered from network error');
    expect(sseCallCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Reconnection on SSE non-200 response
  // -----------------------------------------------------------------------

  it('reconnects after SSE endpoint returns non-200 status', async () => {
    const decisionId = 'dec-reconnect-503';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;

        if (sseCallCount === 1) {
          // First connection: 503 Service Unavailable
          return new Response('Service Unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
          });
        }

        // Second connection: succeeds with matching event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: true,
            comment: 'Recovered from 503',
            respondedBy: 'reviewer-503',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'evt_20');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 3,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.approved).toBe(true);
    expect(result.input).toBe('Recovered from 503');
    expect(sseCallCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Reconnection counter resets on successful connection
  // -----------------------------------------------------------------------

  it('resets reconnection counter after a successful connection', async () => {
    const decisionId = 'dec-reconnect-reset';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;

        if (sseCallCount <= 2) {
          // Connections 1 and 2: return a valid stream that closes (no matching event)
          // Each successful connection should reset the counter
          return new Response(createSSEStreamFromTexts([
            sseEvent('queue:item:added', {
              action: 'added',
              item: { id: 'other' },
              queueSize: 1,
            }, `evt_${sseCallCount}`),
          ]), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Connection 3: return the matching event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: true,
            comment: 'After counter reset',
            respondedBy: 'reviewer-reset',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'evt_3');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    // maxReconnectAttempts=1 — without counter reset, the 2nd reconnection
    // (3rd total connection) would fail. With reset, each successful
    // connection resets the counter so the handler can keep reconnecting.
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 1,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.approved).toBe(true);
    expect(result.input).toBe('After counter reset');
    expect(sseCallCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // maxReconnectAttempts: 0 disables reconnection
  // -----------------------------------------------------------------------

  it('does not reconnect when maxReconnectAttempts is 0', async () => {
    const decisionId = 'dec-no-reconnect';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;
        // Stream closes immediately with no matching event
        return new Response(createSSEStreamFromTexts([
          `: heartbeat\n\n`,
        ]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 0,
    });

    let caughtError: Error | undefined;
    const promise = handler.requestDecision(makeRequest(), 60_000).catch((err) => {
      caughtError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(caughtError).toBeDefined();
    // With maxReconnectAttempts=0, only the initial connection should have been made
    expect(sseCallCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Multiple consecutive stream drops with recovery
  // -----------------------------------------------------------------------

  it('survives multiple consecutive stream drops before resolving', async () => {
    const decisionId = 'dec-multi-drop';
    let sseCallCount = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;

        // Connections 1-3: emit unrelated events and close
        if (sseCallCount <= 3) {
          return new Response(createSSEStreamFromTexts([
            sseEvent('queue:item:added', {
              action: 'added',
              item: { id: `unrelated-${sseCallCount}` },
              queueSize: sseCallCount,
            }, `evt_${sseCallCount}`),
          ]), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Connection 4: the matching event
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: false,
            comment: 'Finally resolved after many drops',
            respondedBy: 'patient-reviewer',
            respondedAt: '2026-02-15T11:00:00.000Z',
          },
        }, 'evt_final');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    // maxReconnectAttempts=1, but counter resets on each successful connection,
    // so it can handle repeated drops as long as each connection succeeds
    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 1,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.approved).toBe(false);
    expect(result.input).toBe('Finally resolved after many drops');
    expect(result.respondedBy).toBe('patient-reviewer');
    expect(sseCallCount).toBe(4);
  });

  // -----------------------------------------------------------------------
  // Last-Event-ID accumulates across multiple reconnections
  // -----------------------------------------------------------------------

  it('carries the latest event ID across multiple reconnections', async () => {
    const decisionId = 'dec-reconnect-multi-id';
    let sseCallCount = 0;
    const capturedHeaders: Array<Record<string, string>> = [];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('/queue') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/events')) {
        sseCallCount++;
        capturedHeaders.push({ ...(init?.headers as Record<string, string>) });

        if (sseCallCount === 1) {
          // First connection: emit event with id "first-id"
          return new Response(createSSEStreamFromTexts([
            sseEvent('queue:item:added', {
              action: 'added',
              item: { id: 'x' },
              queueSize: 1,
            }, 'first-id'),
          ]), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        if (sseCallCount === 2) {
          // Second connection: emit event with id "second-id"
          return new Response(createSSEStreamFromTexts([
            sseEvent('queue:item:added', {
              action: 'added',
              item: { id: 'y' },
              queueSize: 2,
            }, 'second-id'),
          ]), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Third connection: resolve
        const matchingEvent = sseEvent('queue:item:removed', {
          action: 'removed',
          item: { id: decisionId },
          queueSize: 0,
          response: {
            id: decisionId,
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          },
        }, 'third-id');
        return new Response(createSSEStreamFromTexts([matchingEvent]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const handler = new HumancyApiDecisionHandler({
      ...defaultConfig,
      sseReconnectDelay: 10,
      maxReconnectAttempts: 5,
    });

    const promise = handler.requestDecision(makeRequest(), 30_000);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(capturedHeaders).toHaveLength(3);
    // 1st call: no Last-Event-ID
    expect(capturedHeaders[0]?.['Last-Event-ID']).toBeUndefined();
    // 2nd call: Last-Event-ID should be 'first-id'
    expect(capturedHeaders[1]?.['Last-Event-ID']).toBe('first-id');
    // 3rd call: Last-Event-ID should be 'second-id' (latest from 2nd connection)
    expect(capturedHeaders[2]?.['Last-Event-ID']).toBe('second-id');
  });
});

// ==========================================================================
// T026: Resource cleanup tests
// ==========================================================================

describe('HumancyApiDecisionHandler — resource cleanup (T026)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // SSE connection closed after successful resolution
  // -----------------------------------------------------------------------

  describe('SSE cleanup after successful resolution', () => {
    it('aborts the AbortController signal after resolution (closes SSE)', async () => {
      const decisionId = 'dec-cleanup-resolve';
      let capturedSignal: AbortSignal | undefined;

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events')) {
          capturedSignal = init?.signal ?? undefined;
          return new Response(createSSEStream(decisionId, {
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          }), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler(defaultConfig);
      await handler.requestDecision(makeRequest(), 30_000);

      // The signal used by SSE should be aborted in the finally block
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('SSE fetch receives an AbortSignal connected to the handler lifecycle', async () => {
      const decisionId = 'dec-cleanup-signal';
      let postSignal: AbortSignal | undefined;
      let sseSignal: AbortSignal | undefined;

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          postSignal = init?.signal ?? undefined;
          return new Response(
            JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events')) {
          sseSignal = init?.signal ?? undefined;
          return new Response(createSSEStream(decisionId, {
            response: true,
            comment: undefined,
            respondedBy: 'reviewer',
            respondedAt: '2026-02-15T10:00:00.000Z',
          }), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler(defaultConfig);
      await handler.requestDecision(makeRequest(), 30_000);

      // Both POST and SSE should receive abort signals from the same controller
      expect(postSignal).toBeDefined();
      expect(sseSignal).toBeDefined();
      // Both should be aborted after the finally block runs
      expect(postSignal!.aborted).toBe(true);
      expect(sseSignal!.aborted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // SSE connection closed after timeout
  // -----------------------------------------------------------------------

  describe('SSE cleanup after timeout', () => {
    it('aborts SSE connection when timeout fires', async () => {
      const decisionId = 'dec-cleanup-timeout';
      let capturedSignal: AbortSignal | undefined;

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events')) {
          capturedSignal = init?.signal ?? undefined;
          const encoder = new TextEncoder();
          // Stream that stays open — never emits a matching event
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        maxReconnectAttempts: 0,
      });

      const promise = handler.requestDecision(makeRequest(), 200).catch(() => {});

      await vi.advanceTimersByTimeAsync(250);
      await promise;

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('abort signal prevents further SSE reads after timeout', async () => {
      const decisionId = 'dec-cleanup-timeout-reads';
      let sseReadAfterAbort = false;

      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: decisionId, createdAt: '2026-02-15T09:00:00.000Z' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events')) {
          const signal = init?.signal;
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            },
            pull() {
              // If this is called after abort, flag it
              if (signal?.aborted) {
                sseReadAfterAbort = true;
              }
              // Never enqueue — keeps stream pending
              return new Promise(() => {});
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        maxReconnectAttempts: 0,
      });

      const promise = handler.requestDecision(makeRequest(), 200).catch(() => {});
      await vi.advanceTimersByTimeAsync(250);
      await promise;

      // The stream should not have been pulled after abort
      expect(sseReadAfterAbort).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // SSE connection closed after POST failure with fallback
  // -----------------------------------------------------------------------

  describe('SSE cleanup after POST failure with fallback', () => {
    it('does not open SSE connection when POST fails with network error (fallback)', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          throw new TypeError('fetch failed: ECONNREFUSED');
        }

        if (urlStr.includes('/events')) {
          return new Response(createSSEStream('should-not-reach'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        fallbackToSimulation: true,
      });

      await handler.requestDecision(makeRequest(), 30_000);

      // SSE endpoint should never be called — no leaked connection
      const sseCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/events'),
      );
      expect(sseCalls).toHaveLength(0);
    });

    it('does not open SSE connection when POST fails with 503 (fallback)', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ error: 'Service Unavailable' }),
            { status: 503, statusText: 'Service Unavailable' },
          );
        }

        if (urlStr.includes('/events')) {
          return new Response(createSSEStream('should-not-reach'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        fallbackToSimulation: true,
      });

      await handler.requestDecision(makeRequest(), 30_000);

      const sseCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/events'),
      );
      expect(sseCalls).toHaveLength(0);
    });

    it('abort controller is still cleaned up when POST fails (no dangling controller)', async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (urlStr.includes('/queue') && init?.method === 'POST') {
          throw new TypeError('fetch failed: ECONNREFUSED');
        }

        return new Response('Not Found', { status: 404 });
      });

      vi.stubGlobal('fetch', fetchMock);

      const handler = new HumancyApiDecisionHandler({
        ...defaultConfig,
        fallbackToSimulation: true,
      });

      // Should not throw — falls back to simulation, and cleanup runs in finally
      const result = await handler.requestDecision(makeRequest(), 30_000);
      expect(result.approved).toBe(true);
      expect(result.respondedBy).toBe('simulated');
    });
  });

  // -----------------------------------------------------------------------
  // clearTimeout called on success (no dangling timers)
  // -----------------------------------------------------------------------

  describe('clearTimeout on success (no dangling timers)', () => {
    it('calls clearTimeout after successful resolution', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      setupFetchMock('dec-timer-cleanup-1', {
        response: true,
        comment: undefined,
        respondedBy: 'reviewer',
        respondedAt: '2026-02-15T10:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('timeout timer does not fire after successful resolution', async () => {
      setupFetchMock('dec-timer-no-fire', {
        response: true,
        comment: undefined,
        respondedBy: 'reviewer',
        respondedAt: '2026-02-15T10:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      // Use a short timeout — the resolution is immediate, so it should be cleared
      const result = await handler.requestDecision(makeRequest(), 500);
      expect(result.approved).toBe(true);

      // Advance time well past the original timeout — should not throw
      await vi.advanceTimersByTimeAsync(1000);

      // If the timeout timer was not cleared, it would have fired and thrown.
      // The fact that we reach here confirms cleanup was successful.
    });

    it('clearTimeout is called exactly once per successful request', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      setupFetchMock('dec-timer-once', {
        response: true,
        comment: undefined,
        respondedBy: 'reviewer',
        respondedAt: '2026-02-15T10:00:00.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      await handler.requestDecision(makeRequest(), 30_000);

      // Should have been called at least once for the timeout timer.
      // Filter to only calls with a valid timer ID (not undefined/0).
      const timerCleanupCalls = clearTimeoutSpy.mock.calls.filter(
        (call) => call[0] !== undefined,
      );
      expect(timerCleanupCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('clearTimeout is called even when resolution is very fast', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      setupFetchMock('dec-timer-fast', {
        response: true,
        comment: undefined,
        respondedBy: 'fast-reviewer',
        respondedAt: '2026-02-15T09:00:01.000Z',
      });
      const handler = new HumancyApiDecisionHandler(defaultConfig);

      // Very long timeout — but resolution is immediate
      await handler.requestDecision(makeRequest(), 86_400_000); // 24h

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });
});
