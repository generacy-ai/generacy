/**
 * Cluster registry — validates and persists entries via the shared registry.
 */
import { RegistryEntrySchema, readRegistry, writeRegistry, type RegistryEntry } from '../cluster/registry.js';

/**
 * Validates an entry against the shared RegistryEntrySchema and appends it
 * to `~/.generacy/clusters.json`.
 */
export function registerCluster(entry: RegistryEntry): void {
  // Validate against the shared schema (throws on invalid data)
  RegistryEntrySchema.parse(entry);

  const registry = readRegistry();
  registry.push(entry);
  writeRegistry(registry);
}
