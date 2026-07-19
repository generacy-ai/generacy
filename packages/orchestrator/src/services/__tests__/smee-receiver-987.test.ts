import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { SmeeWebhookReceiver } from '../smee-receiver.js';
import type { LabelMonitorService } from '../label-monitor-service.js';
import type { PrFeedbackMonitorService } from '../pr-feedback-monitor-service.js';
import type { MergeConflictMonitorService } from '../merge-conflict-monitor-service.js';
import type { ClarificationAnswerMonitorService } from '../clarification-answer-monitor-service.js';

/**
 * #987 — SmeeWebhookReceiver extensions:
 *   - onConnected callback (fires once, catches thrown callback)
 *   - Broad recordWebhookEvent() fan-out on all four monitors
 *   - Per-event processing dispatch for pull_request_review*, issue_comment
 */

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

interface MockMonitorSet {
  label: LabelMonitorService & { recordWebhookEvent: Mock; parseLabelEvent: Mock; processLabelEvent: Mock; verifyAndProcessCompletedLabel: Mock };
  prFeedback: PrFeedbackMonitorService & { recordWebhookEvent: Mock; processPrReviewEvent: Mock };
  mergeConflict: MergeConflictMonitorService & { recordWebhookEvent: Mock };
  clarification: ClarificationAnswerMonitorService & { recordWebhookEvent: Mock; processClarificationAnswerEvent: Mock };
}

function makeMonitors(): MockMonitorSet {
  const label = {
    recordWebhookEvent: vi.fn(),
    parseLabelEvent: vi.fn().mockReturnValue(null),
    processLabelEvent: vi.fn().mockResolvedValue(true),
    verifyAndProcessCompletedLabel: vi.fn().mockResolvedValue(false),
  } as unknown as MockMonitorSet['label'];
  const prFeedback = {
    recordWebhookEvent: vi.fn(),
    processPrReviewEvent: vi.fn().mockResolvedValue(true),
  } as unknown as MockMonitorSet['prFeedback'];
  const mergeConflict = {
    recordWebhookEvent: vi.fn(),
  } as unknown as MockMonitorSet['mergeConflict'];
  const clarification = {
    recordWebhookEvent: vi.fn(),
    processClarificationAnswerEvent: vi.fn().mockResolvedValue(true),
  } as unknown as MockMonitorSet['clarification'];
  return { label, prFeedback, mergeConflict, clarification };
}

function sseChunk(githubEvent: string, body: unknown): string {
  const payload = { 'x-github-event': githubEvent, body };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Build a fetch response whose body streams the given chunks then closes. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: vi.fn().mockImplementation(async () => {
        if (i < chunks.length) {
          const v = encoder.encode(chunks[i]!);
          i++;
          return { done: false, value: v };
        }
        return { done: true, value: undefined };
      }),
      releaseLock: vi.fn(),
    }),
  };
  return { ok: true, body } as unknown as Response;
}

const OWNER = 'test-org';
const REPO = 'test-repo';
const REPO_KEY = `${OWNER}/${REPO}`;

describe('SmeeWebhookReceiver #987 extensions', () => {
  let logger: { info: Mock; warn: Mock; error: Mock };
  let monitors: MockMonitorSet;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    monitors = makeMonitors();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onConnected callback', () => {
    it('1. fires exactly once across connect / disconnect / reconnect', async () => {
      const onConnected = vi.fn();
      // Two successive connections that each end (stream closes) — the receiver
      // will loop and reconnect. onConnected must still fire only once.
      const first = streamingResponse([]);
      const second = streamingResponse([]);
      mockFetch
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        onConnected,
      });
      const startPromise = receiver.start();
      // Let the receiver run through its loop until fetch rejects.
      await new Promise((r) => setTimeout(r, 30));
      receiver.stop();
      await startPromise;
      expect(onConnected).toHaveBeenCalledTimes(1);
    });

    it('2. never fires when receiver never connects (fetch rejects)', async () => {
      const onConnected = vi.fn();
      mockFetch.mockRejectedValue(new Error('down'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        onConnected,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(onConnected).not.toHaveBeenCalled();
    });

    it('3. thrown onConnected callback is caught; receiver continues processing', async () => {
      const onConnected = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const chunk = sseChunk('issues', {
        action: 'labeled',
        label: { name: 'process:speckit-feature' },
        issue: { number: 1, labels: [{ name: 'process:speckit-feature' }], assignees: [] },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch
        .mockResolvedValueOnce(resp)
        .mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        onConnected,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      // recordWebhookEvent still fired on the subsequent SSE event
      expect(monitors.label.recordWebhookEvent).toHaveBeenCalled();
      // warn was logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining('boom') }),
        expect.stringContaining('onConnected callback threw'),
      );
    });
  });

  describe('broad recordWebhookEvent fan-out', () => {
    it('4. any watched-repo event fires recordWebhookEvent on all four monitors', async () => {
      const chunk = sseChunk('pull_request', {
        action: 'synchronize',
        pull_request: { number: 5, head: { ref: 'feat/x' } },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        prFeedbackMonitor: monitors.prFeedback,
        mergeConflictMonitor: monitors.mergeConflict,
        clarificationAnswerMonitor: monitors.clarification,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.label.recordWebhookEvent).toHaveBeenCalled();
      expect(monitors.prFeedback.recordWebhookEvent).toHaveBeenCalled();
      expect(monitors.mergeConflict.recordWebhookEvent).toHaveBeenCalled();
      expect(monitors.clarification.recordWebhookEvent).toHaveBeenCalled();
    });

    it('5. no fan-out on unwatched repo', async () => {
      const chunk = sseChunk('pull_request', {
        action: 'synchronize',
        pull_request: { number: 5, head: { ref: 'feat/x' } },
        repository: { owner: { login: 'other-org' }, name: 'other-repo' },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        prFeedbackMonitor: monitors.prFeedback,
        mergeConflictMonitor: monitors.mergeConflict,
        clarificationAnswerMonitor: monitors.clarification,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.label.recordWebhookEvent).not.toHaveBeenCalled();
      expect(monitors.prFeedback.recordWebhookEvent).not.toHaveBeenCalled();
      expect(monitors.mergeConflict.recordWebhookEvent).not.toHaveBeenCalled();
      expect(monitors.clarification.recordWebhookEvent).not.toHaveBeenCalled();
    });
  });

  describe('per-event processing dispatch', () => {
    it('6. pull_request_review.submitted → prFeedbackMonitor.processPrReviewEvent', async () => {
      const chunk = sseChunk('pull_request_review', {
        action: 'submitted',
        pull_request: { number: 12, body: 'fixes #42', head: { ref: 'feat/x' } },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        prFeedbackMonitor: monitors.prFeedback,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.prFeedback.processPrReviewEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          prNumber: 12,
          prBody: 'fixes #42',
          branchName: 'feat/x',
          source: 'webhook',
        }),
      );
    });

    it('7. pull_request_review_comment.created → prFeedbackMonitor.processPrReviewEvent', async () => {
      const chunk = sseChunk('pull_request_review_comment', {
        action: 'created',
        pull_request: { number: 13, body: 'body', head: { ref: 'feat/y' } },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        prFeedbackMonitor: monitors.prFeedback,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.prFeedback.processPrReviewEvent).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 13, branchName: 'feat/y' }),
      );
    });

    it('8. issue_comment.created on assigned issue → clarificationAnswerMonitor.processClarificationAnswerEvent', async () => {
      const chunk = sseChunk('issue_comment', {
        action: 'created',
        issue: {
          number: 21,
          labels: [{ name: 'waiting-for:clarification' }, { name: 'agent:paused' }],
          assignees: [{ login: 'bot-user' }],
        },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        clusterGithubUsername: 'bot-user',
        baseReconnectDelayMs: 1,
        clarificationAnswerMonitor: monitors.clarification,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.clarification.processClarificationAnswerEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          issueNumber: 21,
          source: 'poll',
        }),
      );
    });

    it('9. pull_request.synchronize → mergeConflict.recordWebhookEvent only (no processing dispatch)', async () => {
      const chunk = sseChunk('pull_request', {
        action: 'synchronize',
        pull_request: { number: 5, head: { ref: 'feat/x' } },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
        prFeedbackMonitor: monitors.prFeedback,
        mergeConflictMonitor: monitors.mergeConflict,
        clarificationAnswerMonitor: monitors.clarification,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      // Fan-out fires on merge-conflict monitor
      expect(monitors.mergeConflict.recordWebhookEvent).toHaveBeenCalled();
      // Processing dispatch does NOT fire on any monitor for pull_request.synchronize
      expect(monitors.prFeedback.processPrReviewEvent).not.toHaveBeenCalled();
      expect(monitors.clarification.processClarificationAnswerEvent).not.toHaveBeenCalled();
    });

    it('10. optional monitors absent → no crash, label monitor still fed', async () => {
      const chunk = sseChunk('pull_request', {
        action: 'synchronize',
        pull_request: { number: 5, head: { ref: 'feat/x' } },
        repository: { owner: { login: OWNER }, name: REPO },
      });
      const resp = streamingResponse([chunk]);
      mockFetch.mockResolvedValueOnce(resp).mockRejectedValue(new Error('stop'));
      const receiver = new SmeeWebhookReceiver(logger, monitors.label, {
        channelUrl: 'https://smee.io/x',
        watchedRepos: new Set([REPO_KEY]),
        baseReconnectDelayMs: 1,
      });
      const startPromise = receiver.start();
      await new Promise((r) => setTimeout(r, 20));
      receiver.stop();
      await startPromise;
      expect(monitors.label.recordWebhookEvent).toHaveBeenCalled();
      // Other monitors were never wired — no crash
      expect(monitors.prFeedback.recordWebhookEvent).not.toHaveBeenCalled();
      expect(monitors.mergeConflict.recordWebhookEvent).not.toHaveBeenCalled();
      expect(monitors.clarification.recordWebhookEvent).not.toHaveBeenCalled();
    });
  });
});
