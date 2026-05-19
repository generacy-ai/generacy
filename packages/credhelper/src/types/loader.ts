/**
 * Configuration passed to the plugin loader at boot time.
 */
export interface LoaderConfig {
  /** Paths to core plugin directories (trusted by path, no pin required) */
  corePaths: string[];
  /** Paths to community plugin directories (require SHA256 pin verification) */
  communityPaths: string[];
  /** Map of plugin package name → expected SHA256 hex digest (from trusted-plugins.yaml) */
  trustedPins: Map<string, string>;
}

/**
 * The `credhelperPlugin` field from a plugin's package.json.
 */
export interface PluginManifest {
  /** Credential type identifier (e.g., 'vault', 'github-app') */
  type: string;
  /** Semver version of the plugin */
  version: string;
  /** Relative path to the entry point (e.g., './dist/index.js') */
  main: string;
}

/**
 * Metadata for a plugin found during discovery, before loading.
 */
export interface DiscoveredPlugin {
  /** Package name (e.g., 'generacy-credhelper-plugin-vault') */
  name: string;
  /** Absolute path to the plugin package directory */
  path: string;
  /** Absolute path to the entry point file (resolved from manifest.main) */
  entryPoint: string;
  /** Credential type this plugin handles (from manifest) */
  type: string;
  /** Plugin version (from manifest) */
  version: string;
  /** Whether this plugin was found in a core path (trusted) or community path */
  isCore: boolean;
}
