#!/usr/bin/env node

import { resolve } from 'node:path';
import { loadConfig, ConfigValidationError } from '@generacy-ai/credhelper';
import { Daemon } from '../src/daemon.js';
import { CredhelperError } from '../src/errors.js';
import type { CredentialTypePlugin, DaemonConfig } from '../src/types.js';
import { CORE_PLUGINS } from '../src/plugins/core/index.js';
import { DefaultBackendClientFactory } from '../src/backends/factory.js';
import { AuditLog } from '../src/audit/index.js';

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

// Load config from .agency/ directory (Phase 6, #477)
const agencyDir =
  process.env['CREDHELPER_AGENCY_DIR'] ??
  resolve(process.cwd(), '.agency');

let appConfig;
try {
  appConfig = loadConfig({ agencyDir });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error('[credhelper] Config validation failed:');
    for (const e of err.errors) {
      console.error(`  - ${e.file}${e.field ? `: field '${e.field}'` : ''} — ${e.message}`);
    }
  } else {
    console.error('[credhelper] Failed to load config:', err);
  }
  process.exit(1);
}

const config: DaemonConfig = {
  controlSocketPath,
  sessionsDir,
  workerUid,
  workerGid,
  daemonUid: 1002,
  backendFactory: new DefaultBackendClientFactory(),
  configLoader: {
    async loadRole(roleId: string) {
      const role = appConfig.roles.get(roleId);
      if (!role) throw new CredhelperError('ROLE_NOT_FOUND', `Role not found: ${roleId}`);
      return role;
    },
    async loadCredential(credentialId: string) {
      const cred = appConfig.credentials.credentials.find(c => c.id === credentialId);
      if (!cred) throw new CredhelperError('CREDENTIAL_NOT_FOUND', `Credential not found: ${credentialId}`);
      return cred;
    },
    async loadBackend(backendId: string) {
      const backend = appConfig.backends.backends.find(b => b.id === backendId);
      if (!backend) throw new CredhelperError('BACKEND_UNREACHABLE', `Backend not found: ${backendId}`);
      return backend;
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
  clusterId: process.env['GENERACY_CLUSTER_ID'],
  workerId: process.env['GENERACY_WORKER_ID'] ?? process.env['HOSTNAME'],
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
