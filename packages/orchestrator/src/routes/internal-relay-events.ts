import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ClusterRelayClient, RelayMessage } from '../types/relay.js';

const ALLOWED_CHANNELS = [
  'cluster.vscode-tunnel',
  'cluster.audit',
  'cluster.credentials',
  'cluster.bootstrap',
] as const;

export const RelayEventRequestSchema = z.object({
  channel: z.enum(ALLOWED_CHANNELS),
  payload: z.unknown(),
});

export type RelayEventRequest = z.infer<typeof RelayEventRequestSchema>;

export function setupInternalRelayEventsRoute(
  server: FastifyInstance,
  getRelayClient: () => ClusterRelayClient | null,
): void {
  server.post(
    '/internal/relay-events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const client = getRelayClient();
      if (!client) {
        return reply.status(503).send({ error: 'relay not yet initialized' });
      }

      const parsed = RelayEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues,
        });
      }

      const { channel, payload } = parsed.data;

      if (client.isConnected) {
        client.send({
          type: 'event',
          event: channel,
          data: payload,
          timestamp: new Date().toISOString(),
        } as unknown as RelayMessage);
      }

      return reply.status(204).send();
    },
  );
}
