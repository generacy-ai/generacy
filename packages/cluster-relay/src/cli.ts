#!/usr/bin/env node

import { loadConfig } from './config.js';
import { ClusterRelay } from './relay.js';

async function main(): Promise<void> {
  // Parse CLI flags
  const args = process.argv.slice(2);
  const overrides: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--relay-url' && next) {
      overrides['relayUrl'] = next;
      i++;
    } else if (arg === '--orchestrator-url' && next) {
      overrides['orchestratorUrl'] = next;
      i++;
    }
  }

  let config;
  try {
    config = loadConfig(overrides);
  } catch (error) {
    console.error('Configuration error:', String(error));
    process.exit(1);
  }

  const relay = new ClusterRelay(config);

  // Graceful shutdown handlers
  const shutdown = async () => {
    console.log('\nShutting down cluster relay...');
    await relay.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Start the relay
  try {
    await relay.connect();
  } catch (error) {
    console.error('Fatal error:', String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
