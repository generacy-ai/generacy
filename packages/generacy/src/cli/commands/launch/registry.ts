/**
 * Cluster registry — persists cluster entries to ~/.generacy/clusters.json.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import type { ClusterRegistryEntry } from './types.js';

const REGISTRY_DIR = join(homedir(), '.generacy');
const REGISTRY_FILE = join(REGISTRY_DIR, 'clusters.json');
const REGISTRY_TMP = join(REGISTRY_DIR, 'clusters.json.tmp');

/**
 * Appends a cluster entry to `~/.generacy/clusters.json`.
 *
 * Creates the directory and file if they do not already exist.
 * Uses atomic write (temp file + rename) to avoid partial writes.
 *
 * @param entry - The cluster registry entry to append. `createdAt` and
 *   `lastSeen` are expected to be set by the caller.
 */
export function registerCluster(entry: ClusterRegistryEntry): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
  }

  let entries: ClusterRegistryEntry[] = [];

  if (existsSync(REGISTRY_FILE)) {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    entries = JSON.parse(raw) as ClusterRegistryEntry[];
  }

  entries.push(entry);

  writeFileSync(REGISTRY_TMP, JSON.stringify(entries, null, 2), 'utf-8');
  renameSync(REGISTRY_TMP, REGISTRY_FILE);
}
