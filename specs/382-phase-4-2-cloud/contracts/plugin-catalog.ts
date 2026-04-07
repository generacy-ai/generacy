/**
 * Plugin catalog interface contract for /onboard:plugins
 *
 * Defines the structure of the hardcoded plugin catalog and
 * the configuration output written to .generacy/config.yaml
 */

/** A plugin available for installation */
export interface PluginDefinition {
  /** Unique plugin identifier (e.g., "git", "npm", "docker") */
  id: string;
  /** Human-readable name (e.g., "Git Plugin") */
  name: string;
  /** Short description of what the plugin does */
  description: string;
  /** npm package name (e.g., "@generacy-ai/agency-plugin-git") */
  packageName: string;
  /** Stack signals from stack.yaml that trigger a recommendation */
  stackSignals: string[];
  /** Whether to always recommend this plugin regardless of stack */
  alwaysRecommend: boolean;
}

/** User's selection of a plugin */
export interface PluginSelection {
  pluginId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

/** The plugins section written to .generacy/config.yaml */
export interface PluginsConfig {
  plugins: Array<{
    id: string;
    package: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
}

/** Initial hardcoded catalog — 6 known plugins */
export const PLUGIN_CATALOG: PluginDefinition[] = [
  {
    id: 'git',
    name: 'Git Plugin',
    description: 'Git workflow management — branching, commits, PR creation',
    packageName: '@generacy-ai/agency-plugin-git',
    stackSignals: [],
    alwaysRecommend: true,
  },
  {
    id: 'npm',
    name: 'npm Plugin',
    description: 'npm/pnpm/yarn package management — install, update, audit',
    packageName: '@generacy-ai/agency-plugin-npm',
    stackSignals: ['TypeScript', 'JavaScript', 'Node.js', 'React', 'Next.js', 'Express'],
    alwaysRecommend: false,
  },
  {
    id: 'docker',
    name: 'Docker Plugin',
    description: 'Docker container management — build, run, compose',
    packageName: '@generacy-ai/agency-plugin-docker',
    stackSignals: ['Docker'],
    alwaysRecommend: false,
  },
  {
    id: 'firebase',
    name: 'Firebase Plugin',
    description: 'Firebase emulator management and deployment',
    packageName: '@generacy-ai/agency-plugin-firebase',
    stackSignals: ['Firebase'],
    alwaysRecommend: false,
  },
  {
    id: 'humancy',
    name: 'Humancy Plugin',
    description: 'Human-in-the-loop approval workflows for sensitive operations',
    packageName: '@generacy-ai/agency-plugin-humancy',
    stackSignals: [],
    alwaysRecommend: false,
  },
  {
    id: 'spec-kit',
    name: 'Spec Kit Plugin',
    description: 'Specification & planning workflows — specify, clarify, plan, tasks, implement',
    packageName: '@generacy-ai/agency-plugin-spec-kit',
    stackSignals: [],
    alwaysRecommend: true,
  },
];
