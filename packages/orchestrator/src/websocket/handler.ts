import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { AuthContext, ClientMessage } from '../types/index.js';
import { getSubscriptionManager, type SubscriptionManager } from './subscriptions.js';
import {
  parseClientMessage,
  createPongMessage,
  createErrorMessage,
} from './messages.js';

/**
 * WebSocket connection context
 */
interface WebSocketContext {
  ws: WebSocket;
  auth: AuthContext;
  correlationId: string;
}

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(
  context: WebSocketContext,
  message: ClientMessage,
  subscriptionManager: SubscriptionManager
): void {
  const { ws } = context;

  switch (message.type) {
    case 'subscribe':
      subscriptionManager.subscribe(ws, message.channels, message.filters);
      break;

    case 'unsubscribe':
      subscriptionManager.unsubscribe(ws, message.channels);
      break;

    case 'ping':
      subscriptionManager.send(ws, createPongMessage());
      break;
  }
}

/**
 * Setup WebSocket handler
 */
export async function setupWebSocketHandler(server: FastifyInstance): Promise<void> {
  const subscriptionManager = getSubscriptionManager();

  server.get(
    '/ws',
    { websocket: true },
    (connection, request: FastifyRequest) => {
      const ws = connection as unknown as WebSocket;

      // Check authentication
      if (!request.auth || request.auth.userId === 'anonymous') {
        subscriptionManager.send(
          ws,
          createErrorMessage(
            'Unauthorized',
            'WebSocket connections require authentication',
            401,
            request.correlationId
          )
        );
        ws.close(4001, 'Unauthorized');
        return;
      }

      const context: WebSocketContext = {
        ws,
        auth: request.auth,
        correlationId: request.correlationId,
      };

      server.log.info({
        correlationId: request.correlationId,
        userId: request.auth.userId,
      }, 'WebSocket connection established');

      // Handle messages
      ws.on('message', (data: Buffer | string) => {
        try {
          const message = parseClientMessage(data.toString());
          if (!message) {
            subscriptionManager.send(
              ws,
              createErrorMessage(
                'Invalid Message',
                'Message must be valid JSON matching the expected schema',
                400,
                request.correlationId
              )
            );
            return;
          }

          handleMessage(context, message, subscriptionManager);
        } catch (error) {
          server.log.error({ err: error, correlationId: request.correlationId }, 'WebSocket message error');
          subscriptionManager.send(
            ws,
            createErrorMessage(
              'Internal Error',
              'An error occurred processing your message',
              500,
              request.correlationId
            )
          );
        }
      });

      // Handle close
      ws.on('close', () => {
        subscriptionManager.removeClient(ws);
        server.log.info({
          correlationId: request.correlationId,
          userId: request.auth.userId,
        }, 'WebSocket connection closed');
      });

      // Handle errors
      ws.on('error', (error: Error) => {
        server.log.error({
          err: error,
          correlationId: request.correlationId,
          userId: request.auth.userId,
        }, 'WebSocket error');
        subscriptionManager.removeClient(ws);
      });
    }
  );
}

/**
 * Get WebSocket connection count
 */
export function getConnectionCount(): number {
  return getSubscriptionManager().getTotalSubscribers();
}
