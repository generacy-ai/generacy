import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Metrics registry
 */
let registry: Registry;

/**
 * Custom metrics
 */
let httpRequestsTotal: Counter;
let httpRequestDuration: Histogram;
let activeWorkflows: Gauge;
let queueSize: Gauge;
let connectedAgents: Gauge;

/**
 * Initialize metrics
 */
export function initializeMetrics(): Registry {
  registry = new Registry();

  // Collect default Node.js metrics
  collectDefaultMetrics({ register: registry });

  // HTTP request counter
  httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers: [registry],
  });

  // HTTP request duration histogram
  httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path', 'status'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  });

  // Active workflows gauge
  activeWorkflows = new Gauge({
    name: 'orchestrator_active_workflows',
    help: 'Number of active workflows',
    labelNames: ['status'],
    registers: [registry],
  });

  // Queue size gauge
  queueSize = new Gauge({
    name: 'orchestrator_queue_size',
    help: 'Number of items in the decision queue',
    labelNames: ['priority'],
    registers: [registry],
  });

  // Connected agents gauge
  connectedAgents = new Gauge({
    name: 'orchestrator_connected_agents',
    help: 'Number of connected agents',
    labelNames: ['type', 'status'],
    registers: [registry],
  });

  return registry;
}

/**
 * Record HTTP request metrics
 */
export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationSeconds: number
): void {
  if (!httpRequestsTotal || !httpRequestDuration) return;

  // Normalize path (remove IDs)
  const normalizedPath = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');

  httpRequestsTotal.inc({ method, path: normalizedPath, status: String(status) });
  httpRequestDuration.observe(
    { method, path: normalizedPath, status: String(status) },
    durationSeconds
  );
}

/**
 * Update workflow metrics
 */
export function updateWorkflowMetrics(statusCounts: Record<string, number>): void {
  if (!activeWorkflows) return;

  for (const [status, count] of Object.entries(statusCounts)) {
    activeWorkflows.set({ status }, count);
  }
}

/**
 * Update queue metrics
 */
export function updateQueueMetrics(priorityCounts: Record<string, number>): void {
  if (!queueSize) return;

  for (const [priority, count] of Object.entries(priorityCounts)) {
    queueSize.set({ priority }, count);
  }
}

/**
 * Update agent metrics
 */
export function updateAgentMetrics(
  agentCounts: Record<string, Record<string, number>>
): void {
  if (!connectedAgents) return;

  for (const [type, statusCounts] of Object.entries(agentCounts)) {
    for (const [status, count] of Object.entries(statusCounts)) {
      connectedAgents.set({ type, status }, count);
    }
  }
}

/**
 * Setup metrics routes
 */
export async function setupMetricsRoutes(server: FastifyInstance): Promise<void> {
  // Initialize metrics if not already done
  if (!registry) {
    initializeMetrics();
  }

  // GET /metrics - Prometheus metrics endpoint
  server.get(
    '/metrics',
    {
      schema: {
        description: 'Prometheus metrics endpoint',
        tags: ['System'],
        response: {
          200: {
            type: 'string',
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const metrics = await registry.metrics();
      return reply
        .header('content-type', registry.contentType)
        .send(metrics);
    }
  );

  // Add hook to record request metrics
  server.addHook('onResponse', (request, reply, done) => {
    // Skip metrics endpoint itself
    if (request.url === '/metrics') {
      done();
      return;
    }

    // Calculate duration
    const startTime = (request as FastifyRequest & { startTime?: bigint }).startTime;
    let durationSeconds = 0;
    if (startTime) {
      durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
    }

    recordHttpRequest(request.method, request.url, reply.statusCode, durationSeconds);
    done();
  });

  // Add hook to record start time
  server.addHook('onRequest', (request, _reply, done) => {
    (request as FastifyRequest & { startTime: bigint }).startTime = process.hrtime.bigint();
    done();
  });
}

/**
 * Get registry for testing
 */
export function getRegistry(): Registry {
  return registry;
}
