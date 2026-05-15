#!/usr/bin/env node

import { ControlPlaneServer } from '../src/index.js';
import { initClusterState } from '../src/state.js';
import type { DeploymentMode, ClusterVariant } from '../src/schemas.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../src/services/credential-writer.js';
import { setRelayPushEvent } from '../src/relay-events.js';
import { AppConfigEnvStore } from '../src/services/app-config-env-store.js';
import { AppConfigFileStore } from '../src/services/app-config-file-store.js';
import { setAppConfigStores } from '../src/routes/app-config.js';

const DEFAULT_SOCKET_PATH = '/run/generacy-control-plane/control.sock';

const socketPath = process.env['CONTROL_PLANE_SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;

const deploymentMode = (process.env['DEPLOYMENT_MODE'] ?? 'local') as DeploymentMode;
const variant = (process.env['CLUSTER_VARIANT'] ?? 'cluster-base') as ClusterVariant;
initClusterState({ deploymentMode, variant });

// Initialize credential backend eagerly — fail-fast on missing master key
const credentialBackend = new ClusterLocalBackend();

const server = new ControlPlaneServer();

function shutdown() {
  console.log('[control-plane] Shutting down...');
  server.close().then(() => {
    console.log('[control-plane] Stopped.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[control-plane] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[control-plane] Unhandled rejection:', reason);
  process.exit(1);
});

// Wire relay event IPC: POST events to orchestrator for relay forwarding
const orchestratorUrl = process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100';
const internalApiKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];

if (internalApiKey) {
  setRelayPushEvent((event, data) => {
    fetch(`${orchestratorUrl}/internal/relay-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${internalApiKey}`,
      },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    }).catch((err) => {
      console.error('[control-plane] Failed to push relay event:', err instanceof Error ? err.message : String(err));
    });
  });
  console.log('[control-plane] Relay event IPC wired');
} else {
  console.warn('[control-plane] ORCHESTRATOR_INTERNAL_API_KEY not set — relay events will be silently dropped');
}

// Initialize app-config stores
const appConfigEnvStore = new AppConfigEnvStore();
const appConfigFileStore = new AppConfigFileStore(credentialBackend);

credentialBackend
  .init()
  .then(async () => {
    setCredentialBackend(credentialBackend);
    console.log('[control-plane] Credential backend initialized');

    // Initialize app-config stores
    await appConfigEnvStore.init();
    await appConfigFileStore.init();
    setAppConfigStores(appConfigEnvStore, appConfigFileStore, credentialBackend);
    console.log('[control-plane] App-config stores initialized');

    return server.start(socketPath);
  })
  .then(() => {
    console.log(`[control-plane] Listening on ${socketPath}`);
  })
  .catch((err) => {
    console.error('[control-plane] Failed to start:', err);
    process.exit(1);
  });
