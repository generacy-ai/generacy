import type { FastifyInstance } from 'fastify';

/**
 * Shutdown handler state
 */
interface ShutdownState {
  isShuttingDown: boolean;
  shutdownPromise: Promise<void> | null;
}

const state: ShutdownState = {
  isShuttingDown: false,
  shutdownPromise: null,
};

/**
 * Shutdown options
 */
export interface ShutdownOptions {
  /** Timeout for graceful shutdown in milliseconds (default: 30000) */
  timeout?: number;
  /** Logger for shutdown messages */
  logger?: {
    info: (msg: string) => void;
    error: (msg: string, error?: Error) => void;
  };
  /** Additional cleanup functions to run */
  cleanup?: Array<() => Promise<void>>;
}

/**
 * Perform graceful shutdown
 */
async function performShutdown(
  server: FastifyInstance,
  options: ShutdownOptions
): Promise<void> {
  const { timeout = 30000, logger, cleanup = [] } = options;

  logger?.info('Starting graceful shutdown...');

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Shutdown timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    // Close server (stops accepting new connections)
    await Promise.race([server.close(), timeoutPromise]);
    logger?.info('Server closed, stopping new connections');

    // Run cleanup functions
    for (const cleanupFn of cleanup) {
      try {
        await Promise.race([cleanupFn(), timeoutPromise]);
      } catch (error) {
        logger?.error('Cleanup function failed', error as Error);
      }
    }

    logger?.info('Graceful shutdown complete');
  } catch (error) {
    logger?.error('Shutdown failed', error as Error);
    throw error;
  }
}

/**
 * Setup graceful shutdown handlers for SIGTERM and SIGINT
 */
export function setupGracefulShutdown(
  server: FastifyInstance,
  options: ShutdownOptions = {}
): () => Promise<void> {
  const { logger } = options;

  const handleSignal = (signal: string) => {
    return () => {
      if (state.isShuttingDown) {
        logger?.info(`Received ${signal} but already shutting down`);
        return;
      }

      logger?.info(`Received ${signal}, initiating graceful shutdown`);
      state.isShuttingDown = true;

      state.shutdownPromise = performShutdown(server, options)
        .then(() => {
          process.exit(0);
        })
        .catch((error) => {
          logger?.error('Shutdown failed, forcing exit', error);
          process.exit(1);
        });
    };
  };

  // Register signal handlers
  process.on('SIGTERM', handleSignal('SIGTERM'));
  process.on('SIGINT', handleSignal('SIGINT'));

  // Return a function to manually trigger shutdown (for testing)
  return async () => {
    if (state.isShuttingDown && state.shutdownPromise) {
      return state.shutdownPromise;
    }

    state.isShuttingDown = true;
    state.shutdownPromise = performShutdown(server, options);
    return state.shutdownPromise;
  };
}

/**
 * Check if shutdown is in progress
 */
export function isShuttingDown(): boolean {
  return state.isShuttingDown;
}

/**
 * Reset shutdown state (for testing)
 */
export function resetShutdownState(): void {
  state.isShuttingDown = false;
  state.shutdownPromise = null;
}
