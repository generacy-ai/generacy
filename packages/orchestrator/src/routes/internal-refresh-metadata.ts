import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RelayBridge } from '../services/relay-bridge.js';

export function setupInternalRefreshMetadataRoute(
  server: FastifyInstance,
  getRelayBridge: () => RelayBridge | null,
): void {
  server.post(
    '/internal/refresh-metadata',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const bridge = getRelayBridge();
      if (!bridge) {
        return reply.status(503).send({ error: 'relay bridge not yet initialized' });
      }

      await bridge.sendMetadata();
      return reply.status(200).send({ accepted: true });
    },
  );
}
