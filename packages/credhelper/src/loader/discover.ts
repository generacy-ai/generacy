import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DiscoveredPlugin, PluginManifest } from '../types/loader.js';

/** Naming patterns for credhelper plugins */
const PLUGIN_PATTERNS = [
  /^@generacy\/credhelper-plugin-[\w-]+$/,
  /^generacy-credhelper-plugin-[\w-]+$/,
];

function matchesPluginPattern(name: string): boolean {
  return PLUGIN_PATTERNS.some((p) => p.test(name));
}

/**
 * Discover credhelper plugins from the given search paths.
 *
 * Scans directories for packages matching `@generacy/credhelper-plugin-*` and
 * `generacy-credhelper-plugin-*` patterns, reads the `credhelperPlugin` manifest
 * field from each package.json, and returns metadata for each discovered plugin.
 */
export async function discoverPlugins(
  corePaths: string[],
  communityPaths: string[],
): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];

  const scanPath = async (searchPath: string, isCore: boolean) => {
    let entries: string[];
    try {
      entries = await readdir(searchPath);
    } catch {
      // Path doesn't exist — skip silently
      return;
    }

    for (const entry of entries) {
      // Handle scoped packages (@generacy/)
      if (entry.startsWith('@')) {
        const scopedPath = join(searchPath, entry);
        let scopedEntries: string[];
        try {
          scopedEntries = await readdir(scopedPath);
        } catch {
          continue;
        }
        for (const scopedEntry of scopedEntries) {
          const fullName = `${entry}/${scopedEntry}`;
          if (matchesPluginPattern(fullName)) {
            const plugin = await readPluginManifest(
              join(scopedPath, scopedEntry),
              fullName,
              isCore,
            );
            if (plugin) plugins.push(plugin);
          }
        }
      } else if (matchesPluginPattern(entry)) {
        const plugin = await readPluginManifest(
          join(searchPath, entry),
          entry,
          isCore,
        );
        if (plugin) plugins.push(plugin);
      }
    }
  };

  for (const p of corePaths) await scanPath(p, true);
  for (const p of communityPaths) await scanPath(p, false);

  return plugins;
}

async function readPluginManifest(
  pluginDir: string,
  name: string,
  isCore: boolean,
): Promise<DiscoveredPlugin | null> {
  const pkgPath = join(pluginDir, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgPath, 'utf-8');
  } catch {
    return null;
  }

  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const manifest = pkg['credhelperPlugin'] as PluginManifest | undefined;
  if (!manifest?.type || !manifest?.version || !manifest?.main) {
    return null;
  }

  const entryPoint = resolve(pluginDir, manifest.main);

  return {
    name,
    path: pluginDir,
    entryPoint,
    type: manifest.type,
    version: manifest.version,
    isCore,
  };
}
