#!/usr/bin/env node

import { Daemon } from '../src/daemon.js';
import type { CredentialTypePlugin, DaemonConfig } from '../src/types.js';
import { CORE_PLUGINS } from '../src/plugins/core/index.js';

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

// Build plugin registry from core plugins + future community plugins (#460)
const pluginMap = new Map<string, CredentialTypePlugin>();
for (const plugin of CORE_PLUGINS) {
  pluginMap.set(plugin.type, plugin);
}

// Config loader will be provided by #462
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
    getPlugin(credentialType: string) {
      const plugin = pluginMap.get(credentialType);
      if (!plugin) {
        throw new Error(`No plugin registered for credential type: ${credentialType}`);
      }
      return plugin;
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
