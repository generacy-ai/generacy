import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LabelMonitorService } from '../services/label-monitor-service.js';
import type { GitHubWebhookPayload } from '../types/index.js';

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

export interface WebhookRouteOptions {
  monitorService: LabelMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
}

/**
 * Setup webhook routes for receiving GitHub events.
 * The webhook route bypasses global auth middleware — authentication
 * is handled via HMAC-SHA256 signature verification.
 */
export async function setupWebhookRoutes(
  server: FastifyInstance,
  options: WebhookRouteOptions,
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

  // Auth is skipped for /webhooks/github via server.ts skipRoutes config.
  // Authentication is handled via HMAC-SHA256 signature verification.
  server.post(
    '/webhooks/github',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { parsed: unknown; raw: string };
      const rawBody = body.raw;
      const payload = body.parsed as GitHubWebhookPayload;

      // Verify webhook signature
      const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;
      if (!verifySignature(webhookSecret, rawBody, signatureHeader)) {
        server.log.warn('Invalid webhook signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Only handle "labeled" events
      if (payload.action !== 'labeled') {
        return reply.status(200).send({ status: 'ignored', reason: 'not a labeled event' });
      }

      // Verify this is a watched repository
      const repoKey = `${payload.repository.owner.login}/${payload.repository.name}`;
      if (!watchedRepos.has(repoKey)) {
        return reply.status(200).send({ status: 'ignored', reason: 'not a watched repository' });
      }

      // Parse and process the label event
      const issueLabels = payload.issue.labels.map(l => l.name);
      const event = monitorService.parseLabelEvent(
        payload.label.name,
        payload.repository.owner.login,
        payload.repository.name,
        payload.issue.number,
        issueLabels,
        'webhook',
      );

      if (!event) {
        // For completed:* labels without matching waiting-for:*, re-fetch from GitHub
        if (payload.label.name.startsWith('completed:')) {
          server.log.info(
            { label: payload.label.name, repo: repoKey, issue: payload.issue.number },
            'Webhook completed:* label has no matching waiting-for:*, attempting re-fetch',
          );
          monitorService.recordWebhookEvent();
          const refetchResult = await monitorService.verifyAndProcessCompletedLabel(
            payload.repository.owner.login,
            payload.repository.name,
            payload.issue.number,
            payload.label.name,
          );
          return reply.status(200).send({
            status: refetchResult ? 'processed' : 'ignored',
            reason: refetchResult
              ? 'resume detected after label re-fetch'
              : 'no matching waiting-for:* after re-fetch',
          });
        }

        return reply.status(200).send({ status: 'ignored', reason: 'not a trigger label' });
      }

      // Record webhook event for adaptive polling health tracking
      monitorService.recordWebhookEvent();

      // Process the event
      const processed = await monitorService.processLabelEvent(event);

      return reply.status(200).send({
        status: processed ? 'processed' : 'duplicate',
        event: {
          type: event.type,
          issue: event.issueNumber,
          label: event.labelName,
        },
      });
    },
  );
}
