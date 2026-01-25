/**
 * Health check HTTP server.
 * Provides /health endpoint for container orchestration.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Health status response
 */
export interface HealthStatus {
  /** Overall status */
  status: 'healthy' | 'busy' | 'unhealthy';

  /** Uptime in milliseconds */
  uptime?: number;

  /** Last heartbeat timestamp */
  lastHeartbeat?: string;

  /** Currently executing job ID */
  currentJob?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Health server options
 */
export interface HealthServerOptions {
  /** Port to listen on */
  port: number;

  /** Host to bind to */
  host?: string;

  /** Function to get current health status */
  getStatus: () => HealthStatus;
}

/**
 * Health check HTTP server
 */
export interface HealthServer {
  /** Start listening */
  listen(): void;

  /** Stop the server */
  close(): void;

  /** Get the underlying HTTP server */
  getServer(): Server;
}

/**
 * Create a health check HTTP server
 */
export function createHealthServer(options: HealthServerOptions): HealthServer {
  const { port, host = '0.0.0.0', getStatus } = options;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only handle GET /health
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      try {
        const status = getStatus();
        const statusCode = status.status === 'unhealthy' ? 503 : 200;

        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });

        res.end(JSON.stringify({
          ...status,
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        }));
      }
    } else if (req.method === 'GET' && (req.url === '/ready' || req.url === '/ready/')) {
      // Readiness probe - same as health for now
      try {
        const status = getStatus();
        const statusCode = status.status === 'unhealthy' ? 503 : 200;

        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });

        res.end(JSON.stringify({
          ready: status.status !== 'unhealthy',
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ready: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        }));
      }
    } else if (req.method === 'GET' && (req.url === '/live' || req.url === '/live/')) {
      // Liveness probe - always return OK if server is running
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(JSON.stringify({
        alive: true,
        timestamp: new Date().toISOString(),
      }));
    } else {
      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not found',
        path: req.url,
      }));
    }
  });

  return {
    listen() {
      server.listen(port, host, () => {
        console.log(`Health server listening on ${host}:${port}`);
      });
    },

    close() {
      server.close();
    },

    getServer() {
      return server;
    },
  };
}
