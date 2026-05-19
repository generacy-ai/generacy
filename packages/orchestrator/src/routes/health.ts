import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { HealthResponse, HealthStatus, ServiceStatus } from '../types/index.js';
import { probeCodeServerSocket } from '../services/code-server-probe.js';
import { probeControlPlaneSocket } from '../services/control-plane-probe.js';

/**
 * Health check options
 */
export interface HealthCheckOptions {
  /** Custom health checks for services */
  checks?: Record<string, () => Promise<ServiceStatus>>;
}

/**
 * Default health checks
 */
const defaultChecks: Record<string, () => Promise<ServiceStatus>> = {
  server: async () => 'ok',
};

/**
 * Setup health routes
 */
export async function setupHealthRoutes(
  server: FastifyInstance,
  options: HealthCheckOptions = {}
): Promise<void> {
  const checks = { ...defaultChecks, ...options.checks };

  // GET /health - Health check endpoint
  server.get(
    '/health',
    {
      schema: {
        description: 'Health check endpoint',
        tags: ['System'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
              timestamp: { type: 'string', format: 'date-time' },
              services: {
                type: 'object',
                additionalProperties: { type: 'string', enum: ['ok', 'error'] },
              },
              codeServerReady: { type: 'boolean' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
              timestamp: { type: 'string', format: 'date-time' },
              services: {
                type: 'object',
                additionalProperties: { type: 'string', enum: ['ok', 'error'] },
              },
              codeServerReady: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const services: Record<string, ServiceStatus> = {};
      let overallStatus: HealthStatus = 'ok';

      // Run all health checks
      for (const [name, check] of Object.entries(checks)) {
        try {
          services[name] = await check();
          if (services[name] === 'error') {
            overallStatus = 'degraded';
          }
        } catch {
          services[name] = 'error';
          overallStatus = 'degraded';
        }
      }

      // If all services are down, status is error
      const allError = Object.values(services).every((s) => s === 'error');
      if (allError && Object.keys(services).length > 0) {
        overallStatus = 'error';
      }

      const [codeServerReady, controlPlaneReady] = await Promise.all([
        probeCodeServerSocket(),
        probeControlPlaneSocket(),
      ]);

      const response: HealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        services,
        codeServerReady,
        controlPlaneReady,
      };

      const statusCode = overallStatus === 'error' ? 503 : 200;
      return reply.status(statusCode).send(response);
    }
  );

  // GET /health/live - Liveness probe (Kubernetes)
  server.get(
    '/health/live',
    {
      schema: {
        description: 'Liveness probe',
        tags: ['System'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ status: 'ok' });
    }
  );

  // GET /health/ready - Readiness probe (Kubernetes)
  server.get(
    '/health/ready',
    {
      schema: {
        description: 'Readiness probe',
        tags: ['System'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Check critical services
      let ready = true;

      for (const [, check] of Object.entries(checks)) {
        try {
          const status = await check();
          if (status === 'error') {
            ready = false;
            break;
          }
        } catch {
          ready = false;
          break;
        }
      }

      if (ready) {
        return reply.send({ status: 'ok' });
      } else {
        return reply.status(503).send({ status: 'not ready' });
      }
    }
  );
}
