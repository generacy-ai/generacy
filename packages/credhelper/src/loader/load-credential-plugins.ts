import type { CredentialTypePlugin } from '../types/plugin.js';
import type { LoaderConfig } from '../types/loader.js';
import { discoverPlugins } from './discover.js';
import { verifyPluginPins } from './verify.js';
import { validatePlugin } from './validate.js';

/**
 * Discover, verify, and load credential type plugins.
 *
 * Orchestrates the full plugin loading pipeline:
 * 1. Discover plugins from core and community paths
 * 2. Verify SHA256 pins for community plugins
 * 3. Dynamically import each plugin's entry point
 * 4. Validate each plugin implements CredentialTypePlugin
 * 5. Register in a Map keyed by credential type
 *
 * Throws on any verification failure, invalid plugin, or duplicate type.
 * Runs once at boot — no hot reload.
 */
export async function loadCredentialPlugins(
  config: LoaderConfig,
): Promise<Map<string, CredentialTypePlugin>> {
  const { corePaths, communityPaths, trustedPins } = config;

  // 1. Discover
  const discovered = await discoverPlugins(corePaths, communityPaths);

  // 2. Verify pins
  const verified = await verifyPluginPins(discovered, trustedPins);

  // 3. Load, validate, register
  const registry = new Map<string, CredentialTypePlugin>();

  for (const plugin of verified) {
    // Dynamic import (works for both ESM and CJS in Node 20+)
    const mod = await import(plugin.entryPoint);
    const exported = mod.default ?? mod;

    // Validate interface
    const validated = validatePlugin(exported, plugin.name);

    // Check for duplicate type
    const existing = registry.get(validated.type);
    if (existing) {
      // Find the name of the existing plugin from discovered list
      const existingPlugin = verified.find(
        (p) => p.type === validated.type && p.name !== plugin.name,
      );
      throw new Error(
        `Duplicate credential type '${validated.type}' from plugins: ${existingPlugin?.name ?? 'unknown'}, ${plugin.name}`,
      );
    }

    registry.set(validated.type, validated);
  }

  return registry;
}
