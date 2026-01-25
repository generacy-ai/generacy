#!/usr/bin/env node

/**
 * Generacy CLI entry point
 */
import { run } from '../dist/cli/index.js';

run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
