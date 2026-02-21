import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrFeedbackMonitorService } from '../services/pr-feedback-monitor-service.js';
import type { GitHubPrReviewWebhookPayload, PrReviewEvent } from '../types/index.js';

/**
 * Verify the HMAC-SHA256 signature from GitHub webhook.
 * Returns true if signature is valid or if no secret is configured.
 */
function verifySignature(secret: string | undefined, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!secret) {
    // No secret configured — skip verification (dev mode)
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const signature = signatureHeader.slice(expectedPrefix.length);
  const hmac = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(hmac, 'hex'));
  } catch {
    return false;
  }
}

export interface PrWebhookRouteOptions {
  monitorService: PrFeedbackMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
}

/**
 * Setup webhook routes for receiving GitHub PR review events.
 * The webhook route bypasses global auth middleware — authentication
 * is handled via HMAC-SHA256 signature verification.
 */
export async function setupPrWebhookRoutes(
  server: FastifyInstance,
  options: PrWebhookRouteOptions,
): Promise<void> {
  const { monitorService, webhookSecret, watchedRepos } = options;

  // Register a custom content type parser to capture raw body for signature verification
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const json = JSON.parse(body as string);
        // Attach raw body for signature verification
        done(null, { parsed: json, raw: body });
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Auth is skipped for /webhooks/github/pr-review via server.ts skipRoutes config.
  // Authentication is handled via HMAC-SHA256 signature verification.
  server.post(
    '/webhooks/github/pr-review',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { parsed: unknown; raw: string };
      const rawBody = body.raw;
      const payload = body.parsed as GitHubPrReviewWebhookPayload;

      // Verify webhook signature
      const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;
      if (!verifySignature(webhookSecret, rawBody, signatureHeader)) {
        server.log.warn('Invalid webhook signature for PR review event');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Check the GitHub event type from the X-GitHub-Event header
      const eventType = request.headers['x-github-event'] as string | undefined;

      // Only handle pull_request_review.submitted and pull_request_review_comment.created events
      const validEvents = ['pull_request_review', 'pull_request_review_comment'];
      if (!eventType || !validEvents.includes(eventType)) {
        return reply.status(200).send({
          status: 'ignored',
          reason: `not a PR review event (got: ${eventType})`
        });
      }

      // For pull_request_review events, only process "submitted" action
      if (eventType === 'pull_request_review' && payload.action !== 'submitted') {
        return reply.status(200).send({
          status: 'ignored',
          reason: `not a submitted review (got action: ${payload.action})`
        });
      }

      // For pull_request_review_comment events, only process "created" action
      if (eventType === 'pull_request_review_comment' && payload.action !== 'created') {
        return reply.status(200).send({
          status: 'ignored',
          reason: `not a created comment (got action: ${payload.action})`
        });
      }

      // Verify this is a watched repository
      const repoKey = `${payload.repository.owner.login}/${payload.repository.name}`;
      if (!watchedRepos.has(repoKey)) {
        return reply.status(200).send({
          status: 'ignored',
          reason: 'not a watched repository'
        });
      }

      // Build PrReviewEvent from webhook payload
      const event: PrReviewEvent = {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        prNumber: payload.pull_request.number,
        prBody: payload.pull_request.body || '',
        branchName: payload.pull_request.head.ref,
        source: 'webhook',
      };

      // Record webhook event for adaptive polling health tracking
      monitorService.recordWebhookEvent();

      // Process the event
      const processed = await monitorService.processPrReviewEvent(event);

      return reply.status(200).send({
        status: processed ? 'processed' : 'duplicate',
        event: {
          type: eventType,
          action: payload.action,
          pr: payload.pull_request.number,
          repo: repoKey,
        },
      });
    },
  );
}
