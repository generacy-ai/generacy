#!/usr/bin/env node

import { checkNodeVersion } from '../dist/cli/utils/node-version.js';

checkNodeVersion(22);

const { run } = await import('../dist/cli/index.js');

run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
