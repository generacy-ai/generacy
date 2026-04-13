#!/usr/bin/env node

import { Daemon } from '../src/daemon.js';
import type { DaemonConfig } from '../src/types.js';

const controlSocketPath =
  process.env['CREDHELPER_CONTROL_SOCKET'] ??
  '/run/generacy-credhelper/control.sock';

const sessionsDir =
  process.env['CREDHELPER_SESSIONS_DIR'] ??
  '/run/generacy-credhelper/sessions';

const workerUid = parseInt(
  process.env['CREDHELPER_WORKER_UID'] ?? '1000',
  10,
);

const workerGid = parseInt(
  process.env['CREDHELPER_WORKER_GID'] ?? '1000',
  10,
);

// Config loader and plugin registry will be provided by #462 and #460
// For now, create stub implementations that fail clearly
const config: DaemonConfig = {
  controlSocketPath,
  sessionsDir,
  workerUid,
  workerGid,
  daemonUid: 1002,
  configLoader: {
    async loadRole() {
      throw new Error('Config loader not yet integrated (#462)');
    },
    async loadCredential() {
      throw new Error('Config loader not yet integrated (#462)');
    },
    async loadBackend() {
      throw new Error('Config loader not yet integrated (#462)');
    },
  },
  pluginRegistry: {
    getPlugin() {
      throw new Error('Plugin registry not yet integrated (#460)');
    },
  },
  sweepIntervalMs: 30000,
  enablePeerCred: true,
};

const daemon = new Daemon(config);
daemon.installSignalHandlers();

// Handle uncaught exceptions — fail closed
process.on('uncaughtException', (err) => {
  console.error('[credhelper] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[credhelper] Unhandled rejection:', reason);
  process.exit(1);
});

daemon.start().catch((err) => {
  console.error('[credhelper] Fatal startup error:', err);
  process.exit(1);
});
