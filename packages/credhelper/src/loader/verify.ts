import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DiscoveredPlugin } from '../types/loader.js';

/**
 * Verify SHA256 pins for discovered plugins.
 *
 * Core plugins are trusted by path and skip verification.
 * Community plugins must have a matching SHA256 pin in the trustedPins map.
 * Throws on unpinned or mismatched community plugins.
 */
export async function verifyPluginPins(
  plugins: DiscoveredPlugin[],
  trustedPins: Map<string, string>,
): Promise<DiscoveredPlugin[]> {
  for (const plugin of plugins) {
    if (plugin.isCore) continue;

    const expectedPin = trustedPins.get(plugin.name);
    if (!expectedPin) {
      throw new Error(
        `Plugin '${plugin.name}' from community path is not pinned in trusted-plugins.yaml. ` +
          `Compute SHA256 of ${plugin.entryPoint} and add it.`,
      );
    }

    const content = await readFile(plugin.entryPoint);
    const actualPin = createHash('sha256').update(content).digest('hex');

    if (actualPin !== expectedPin) {
      throw new Error(
        `Plugin '${plugin.name}' SHA256 mismatch: expected ${expectedPin}, got ${actualPin}`,
      );
    }
  }

  return plugins;
}
