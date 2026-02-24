/**
 * Setup services subcommand.
 * Starts Firebase emulators and API servers for local development.
 * Replaces .devcontainer/setup-cloud-services.sh
 */
import { Command } from 'commander';
import { type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { getLogger } from '../../utils/logger.js';
import { exec, execSafe, spawnBackground } from '../../utils/exec.js';

/**
 * Services configuration resolved from CLI args.
 */
interface ServicesConfig {
  only: 'all' | 'generacy' | 'humancy';
  skipApi: boolean;
  timeout: number;
  logDir: string;
}

/**
 * Service definition for a cloud project.
 */
interface ServiceDef {
  name: string;
  cloudDir: string;
  emulatorPorts: { firestore: number; auth: number; ui: number };
  api: { port: number; projectId: string };
}

/**
 * Port allocations and directory paths per service.
 */
const SERVICES: Record<'generacy' | 'humancy', ServiceDef> = {
  generacy: {
    name: 'generacy',
    cloudDir: '/workspaces/generacy-cloud',
    emulatorPorts: { firestore: 8080, auth: 9099, ui: 4000 },
    api: { port: 3010, projectId: 'generacy-cloud' },
  },
  humancy: {
    name: 'humancy',
    cloudDir: '/workspaces/humancy-cloud',
    emulatorPorts: { firestore: 8081, auth: 9199, ui: 4001 },
    api: { port: 3002, projectId: 'humancy-cloud' },
  },
};

/**
 * Resolve services config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveServicesConfig(cliArgs: Partial<ServicesConfig>): ServicesConfig {
  return {
    only: cliArgs.only ?? 'all',
    skipApi: cliArgs.skipApi ?? false,
    timeout: cliArgs.timeout ?? 60,
    logDir: cliArgs.logDir ?? '/tmp/cloud-services',
  };
}

/**
 * Get the list of enabled services based on the --only filter.
 */
function getEnabledServices(
  only: ServicesConfig['only'],
): ServiceDef[] {
  if (only === 'all') {
    return [SERVICES.generacy, SERVICES.humancy];
  }
  return [SERVICES[only]];
}

/**
 * Ensure dependencies are installed for a cloud repo.
 * Checks that node_modules has a reasonable number of entries.
 */
function ensureDeps(service: ServiceDef): void {
  const logger = getLogger();

  if (!existsSync(service.cloudDir)) {
    logger.warn(
      { dir: service.cloudDir },
      `${service.name}-cloud directory not found, skipping`,
    );
    return;
  }

  const nodeModulesDir = join(service.cloudDir, 'node_modules');
  let modCount = 0;
  try {
    modCount = readdirSync(nodeModulesDir).length;
  } catch {
    // node_modules doesn't exist
  }

  if (modCount < 10) {
    logger.info({ service: service.name }, 'Installing dependencies');
    exec('pnpm install', { cwd: service.cloudDir });
  }
}

/**
 * Build a cloud repo if the API dist directory is missing.
 */
function buildIfNeeded(service: ServiceDef): void {
  const logger = getLogger();
  const apiDist = join(service.cloudDir, 'services', 'api', 'dist');

  if (!existsSync(apiDist)) {
    logger.info({ service: service.name }, 'Building');
    exec('pnpm run build', { cwd: service.cloudDir });
  } else {
    logger.debug({ service: service.name }, 'Already built');
  }
}

/**
 * Start Firebase emulators for a service.
 * Returns the spawned child process.
 */
function startEmulators(
  service: ServiceDef,
  logDir: string,
): ChildProcess {
  const logger = getLogger();
  const logFile = join(logDir, `${service.name}-emulators.log`);
  const out = createWriteStream(logFile);

  logger.info(
    {
      service: service.name,
      firestore: service.emulatorPorts.firestore,
      auth: service.emulatorPorts.auth,
      ui: service.emulatorPorts.ui,
    },
    'Starting Firebase emulators',
  );

  const child = spawnBackground('firebase', ['emulators:start'], {
    cwd: service.cloudDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  logger.info(
    { service: service.name, pid: child.pid, log: logFile },
    'Emulators started',
  );

  return child;
}

/**
 * Start the API dev server for a service.
 * Returns the spawned child process.
 */
function startApiServer(
  service: ServiceDef,
  logDir: string,
): ChildProcess {
  const logger = getLogger();
  const logFile = join(logDir, `${service.name}-api.log`);
  const out = createWriteStream(logFile);
  const apiDir = join(service.cloudDir, 'services', 'api');

  logger.info(
    { service: service.name, port: service.api.port },
    'Starting API server',
  );

  const child = spawnBackground('npx', ['tsx', 'watch', 'src/index.ts'], {
    cwd: apiDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${service.emulatorPorts.firestore}`,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${service.emulatorPorts.auth}`,
      FIREBASE_PROJECT_ID: service.api.projectId,
      PORT: String(service.api.port),
      STRIPE_API_KEY: process.env['STRIPE_API_KEY'] ?? 'sk_test_dev_placeholder',
      STRIPE_SECRET_KEY: process.env['STRIPE_SECRET_KEY'] ?? 'sk_test_dev_placeholder',
      STRIPE_WEBHOOK_SECRET: process.env['STRIPE_WEBHOOK_SECRET'] ?? 'whsec_test_dev_placeholder',
    },
  });

  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  logger.info(
    { service: service.name, pid: child.pid, log: logFile },
    'API server started',
  );

  return child;
}

/**
 * Wait for a TCP port to become available.
 * Uses net.Socket for zero-dependency health checks.
 */
async function waitForPort(
  port: number,
  name: string,
  timeoutSec: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.connect(port, '127.0.0.1', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('timeout'));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/**
 * Register graceful shutdown handler.
 * Sends SIGTERM to all children, then SIGKILL after 5 seconds.
 */
function registerShutdownHandler(children: ChildProcess[]): void {
  const logger = getLogger();

  const shutdown = () => {
    logger.info('Shutting down services');

    for (const child of children) {
      if (child.pid && !child.killed) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Process may already be dead
        }
      }
    }

    // Force kill after 5 seconds
    setTimeout(() => {
      for (const child of children) {
        if (child.pid && !child.killed) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Process may already be dead
          }
        }
      }
    }, 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Create the `setup services` subcommand.
 */
export function setupServicesCommand(): Command {
  const command = new Command('services');

  command
    .description('Start Firebase emulators and API servers')
    .option(
      '--only <target>',
      'Start only generacy or humancy services (default: all)',
      'all',
    )
    .option('--skip-api', 'Start only emulators without API servers')
    .option(
      '--timeout <seconds>',
      'Health check timeout in seconds',
      '60',
    )
    .action(async (options) => {
      const logger = getLogger();
      const config = resolveServicesConfig({
        ...options,
        timeout: options.timeout ? Number(options.timeout) : undefined,
      });

      logger.info('Starting cloud backend services');
      logger.info(
        { only: config.only, skipApi: config.skipApi, timeout: config.timeout },
        'Configuration',
      );

      // Step 1: Setup log directory and truncate existing logs
      mkdirSync(config.logDir, { recursive: true });
      const enabledServices = getEnabledServices(config.only);

      for (const service of enabledServices) {
        // Truncate existing log files
        const emulatorLog = join(config.logDir, `${service.name}-emulators.log`);
        const apiLog = join(config.logDir, `${service.name}-api.log`);
        writeFileSync(emulatorLog, '');
        if (!config.skipApi) {
          writeFileSync(apiLog, '');
        }
      }

      // Track all spawned children for shutdown handler
      const children: ChildProcess[] = [];
      registerShutdownHandler(children);

      // Step 2: Ensure deps & build per service
      for (const service of enabledServices) {
        if (!existsSync(service.cloudDir)) {
          logger.warn(
            { service: service.name, dir: service.cloudDir },
            'Cloud directory not found, skipping',
          );
          continue;
        }

        ensureDeps(service);
        buildIfNeeded(service);
      }

      // Step 3: Start emulators
      for (const service of enabledServices) {
        if (!existsSync(service.cloudDir)) {
          continue;
        }
        const child = startEmulators(service, config.logDir);
        children.push(child);
      }

      // Step 4: Start API servers (unless --skip-api)
      if (!config.skipApi) {
        for (const service of enabledServices) {
          if (!existsSync(service.cloudDir)) {
            continue;
          }
          const child = startApiServer(service, config.logDir);
          children.push(child);
        }
      }

      // Step 5: Health checks
      logger.info('Waiting for services to be ready');

      for (const service of enabledServices) {
        if (!existsSync(service.cloudDir)) {
          continue;
        }

        // Wait for emulator ports
        const firestoreReady = await waitForPort(
          service.emulatorPorts.firestore,
          `${service.name} Firestore`,
          config.timeout,
        );
        if (firestoreReady) {
          logger.info(
            { service: service.name, port: service.emulatorPorts.firestore },
            'Firestore emulator ready',
          );
        } else {
          logger.warn(
            { service: service.name, port: service.emulatorPorts.firestore, timeout: config.timeout },
            'Firestore emulator not ready after timeout',
          );
        }

        // Wait for API port (unless --skip-api)
        if (!config.skipApi) {
          const apiTimeout = Math.min(config.timeout, 30);
          const apiReady = await waitForPort(
            service.api.port,
            `${service.name} API`,
            apiTimeout,
          );
          if (apiReady) {
            logger.info(
              { service: service.name, port: service.api.port },
              'API server ready',
            );
          } else {
            logger.warn(
              { service: service.name, port: service.api.port, timeout: apiTimeout },
              'API server not ready after timeout',
            );
          }
        }
      }

      logger.info({ logDir: config.logDir }, 'Cloud services started');
    });

  return command;
}
