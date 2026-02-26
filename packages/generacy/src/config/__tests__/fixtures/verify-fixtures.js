#!/usr/bin/env node
/**
 * Verification script for test fixtures
 * Run this to validate that all fixtures behave as expected
 *
 * Usage: node verify-fixtures.js
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseConfig } from '../../../../dist/config/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturesDir = __dirname;

// Get all YAML files
const yamlFiles = readdirSync(fixturesDir)
  .filter(f => f.endsWith('.yaml'))
  .sort();

console.log('Verifying test fixtures...\n');

let passed = 0;
let failed = 0;

for (const file of yamlFiles) {
  const filePath = join(fixturesDir, file);
  const yaml = readFileSync(filePath, 'utf-8');
  const isValid = file.startsWith('valid-');

  try {
    const config = parseConfig(yaml);

    if (isValid) {
      console.log(`✓ ${file} - parsed successfully`);
      passed++;
    } else {
      console.log(`✗ ${file} - SHOULD HAVE FAILED but parsed successfully`);
      failed++;
    }
  } catch (error) {
    if (!isValid) {
      console.log(`✓ ${file} - correctly failed (${error.constructor.name})`);
      passed++;
    } else {
      console.log(`✗ ${file} - SHOULD HAVE PARSED but failed: ${error.message}`);
      failed++;
    }
  }
}

// Verify discovery test fixture
console.log('\nVerifying discovery test fixture...');
const discoveryConfig = join(fixturesDir, 'discovery-test', '.generacy', 'config.yaml');
try {
  const yaml = readFileSync(discoveryConfig, 'utf-8');
  const config = parseConfig(yaml);
  if (config.project.id === 'proj_discovery') {
    console.log('✓ discovery-test/.generacy/config.yaml - parsed successfully');
    passed++;
  } else {
    console.log('✗ discovery-test/.generacy/config.yaml - unexpected project ID');
    failed++;
  }
} catch (error) {
  console.log(`✗ discovery-test/.generacy/config.yaml - ${error.message}`);
  failed++;
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Total: ${passed + failed} fixtures`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
