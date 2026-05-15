#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlPlaneServer } from '../src/index.js';
import { initClusterState } from '../src/state.js';
import type { DeploymentMode, ClusterVariant } from '../src/schemas.js';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../src/services/credential-writer.js';
import { setRelayPushEvent } from '../src/relay-events.js';
import { AppConfigEnvStore } from '../src/services/app-config-env-store.js';
import { AppConfigFileStore } from '../src/services/app-config-file-store.js';
import { setAppConfigStores } from '../src/routes/app-config.js';
import type { InitResult } from '../src/types/init-result.js';

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

const INIT_RESULT_PATH = '/run/generacy-control-plane/init-result.json';

async function writeInitResult(initResult: InitResult): Promise<void> {
  const dir = path.dirname(INIT_RESULT_PATH);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist or be unwritable — best effort
  }
  const tmpPath = `${INIT_RESULT_PATH}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify({ ...initResult, timestamp: new Date().toISOString() }));
    await fs.rename(tmpPath, INIT_RESULT_PATH);
  } catch (err) {
    console.error('[control-plane] Failed to write init-result.json:', err instanceof Error ? err.message : String(err));
  }
}

credentialBackend
  .init()
  .then(async () => {
    setCredentialBackend(credentialBackend);
    console.log('[control-plane] Credential backend initialized');

    // Initialize app-config stores individually with structured error handling
    const initResult: InitResult = { stores: {}, warnings: [] };

    try {
      await appConfigEnvStore.init();
    } catch (err) {
      console.error('[control-plane] AppConfigEnvStore init error (unexpected):', err instanceof Error ? err.message : String(err));
    }
    const envResult = appConfigEnvStore.getInitResult();
    initResult.stores['appConfigEnv'] = envResult;
    console.log(JSON.stringify({ event: 'store-init', store: 'appConfigEnv', ...envResult }));
    if (envResult.status !== 'ok') {
      initResult.warnings.push(`appConfigEnv: ${envResult.reason ?? envResult.status}`);
    }

    try {
      await appConfigFileStore.init();
    } catch (err) {
      console.error('[control-plane] AppConfigFileStore init error (unexpected):', err instanceof Error ? err.message : String(err));
    }
    const fileResult = appConfigFileStore.getInitResult();
    initResult.stores['appConfigFile'] = fileResult;
    console.log(JSON.stringify({ event: 'store-init', store: 'appConfigFile', ...fileResult }));
    if (fileResult.status !== 'ok') {
      initResult.warnings.push(`appConfigFile: ${fileResult.reason ?? fileResult.status}`);
    }

    setAppConfigStores(appConfigEnvStore, appConfigFileStore, credentialBackend);
    console.log('[control-plane] App-config stores initialized');

    await writeInitResult(initResult);

    return server.start(socketPath);
  })
  .then(() => {
    console.log(`[control-plane] Listening on ${socketPath}`);
  })
  .catch((err) => {
    console.error('[control-plane] Failed to start:', err);
    process.exit(1);
  });
