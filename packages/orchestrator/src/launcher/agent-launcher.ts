import type { ProcessFactory } from '../worker/types.js';
import type {
  AgentLaunchPlugin,
  LaunchHandle,
  LaunchRequest,
} from './types.js';

/**
 * Plugin-based process launcher with registry dispatch.
 *
 * Resolves a LaunchRequest's intent to a registered plugin, delegates
 * command/args/env construction to the plugin, performs 3-layer env merge,
 * selects a ProcessFactory by stdio profile, and returns a LaunchHandle.
 */
export class AgentLauncher {
  private readonly kindToPlugin = new Map<string, AgentLaunchPlugin>();

  constructor(
    private readonly factories: Map<string, ProcessFactory>,
  ) {}

  /**
   * Register a plugin for the intent kinds it supports.
   * Throws on duplicate kind registration.
   */
  registerPlugin(plugin: AgentLaunchPlugin): void {
    for (const kind of plugin.supportedKinds) {
      if (this.kindToPlugin.has(kind)) {
        const existing = this.kindToPlugin.get(kind)!;
        throw new Error(
          `Intent kind "${kind}" already registered by plugin "${existing.pluginId}"`,
        );
      }
      this.kindToPlugin.set(kind, plugin);
    }
  }

  /**
   * Launch a process based on the request's intent.
   *
   * 1. Resolve plugin from registry by intent kind
   * 2. Call plugin.buildLaunch() to get LaunchSpec
   * 3. Merge env: process.env ← plugin env ← caller env
   * 4. Select ProcessFactory by LaunchSpec.stdioProfile
   * 5. Spawn process and return LaunchHandle
   */
  launch(request: LaunchRequest): LaunchHandle {
    const { intent } = request;

    // 1. Resolve plugin
    const plugin = this.kindToPlugin.get(intent.kind);
    if (!plugin) {
      const availableKinds = [...this.kindToPlugin.keys()].join(', ');
      throw new Error(
        `Unknown intent kind "${intent.kind}". Available kinds: ${availableKinds}`,
      );
    }

    // 2. Build launch spec
    const launchSpec = plugin.buildLaunch(intent);

    // 3. Merge env: process.env ← plugin env ← caller env
    const mergedEnv: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...launchSpec.env,
      ...request.env,
    };

    // 4. Select factory by stdio profile
    const stdioProfile = launchSpec.stdioProfile ?? 'default';
    const factory = this.factories.get(stdioProfile);
    if (!factory) {
      const availableProfiles = [...this.factories.keys()].join(', ');
      throw new Error(
        `Unknown stdio profile "${stdioProfile}". Available profiles: ${availableProfiles}`,
      );
    }

    // 5. Spawn and return handle
    const detached = request.detached ?? launchSpec.detached;
    const childProcess = factory.spawn(launchSpec.command, launchSpec.args, {
      cwd: request.cwd,
      env: mergedEnv,
      signal: request.signal,
      ...(detached !== undefined && { detached }),
    });

    const outputParser = plugin.createOutputParser();

    return {
      process: childProcess,
      outputParser,
      metadata: {
        pluginId: plugin.pluginId,
        intentKind: intent.kind,
      },
    };
  }
}
