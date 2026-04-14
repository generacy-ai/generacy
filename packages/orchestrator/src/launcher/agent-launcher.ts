import type { ProcessFactory } from '../worker/types.js';
import type {
  AgentLaunchPlugin,
  LaunchHandle,
  LaunchRequest,
} from './types.js';
import type { CredhelperClient } from './credhelper-client.js';
import { applyCredentials } from './credentials-interceptor.js';
import { CredhelperUnavailableError } from './credhelper-errors.js';

/**
 * Plugin-based process launcher with registry dispatch.
 *
 * Resolves a LaunchRequest's intent to a registered plugin, delegates
 * command/args/env construction to the plugin, performs 3-layer env merge,
 * optionally applies credentials interceptor, selects a ProcessFactory
 * by stdio profile, and returns a LaunchHandle.
 */
export class AgentLauncher {
  private readonly kindToPlugin = new Map<string, AgentLaunchPlugin>();
  private readonly credhelperClient?: CredhelperClient;

  constructor(
    private readonly factories: Map<string, ProcessFactory>,
    credhelperClient?: CredhelperClient,
  ) {
    this.credhelperClient = credhelperClient;
  }

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
   * 4. If credentials: apply credentials interceptor (begin session, merge env, wrap command)
   * 5. Select ProcessFactory by LaunchSpec.stdioProfile
   * 6. Spawn process and return LaunchHandle
   * 7. If credentials: register exit cleanup (end session)
   */
  async launch(request: LaunchRequest): Promise<LaunchHandle> {
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
    let mergedEnv: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...launchSpec.env,
      ...request.env,
    };

    let spawnCommand = launchSpec.command;
    let spawnArgs = launchSpec.args;
    let spawnUid: number | undefined;
    let spawnGid: number | undefined;
    let sessionId: string | undefined;

    // 4. Credentials interceptor
    if (request.credentials) {
      if (!this.credhelperClient) {
        throw new CredhelperUnavailableError(
          '/run/generacy-credhelper/control.sock',
          new Error('No CredhelperClient provided to AgentLauncher'),
        );
      }

      const result = await applyCredentials(
        this.credhelperClient,
        request.credentials,
        spawnCommand,
        spawnArgs,
        mergedEnv,
      );

      spawnCommand = result.command;
      spawnArgs = result.args;
      mergedEnv = result.env;
      spawnUid = result.uid;
      spawnGid = result.gid;
      sessionId = result.sessionId;
    }

    // 5. Select factory by stdio profile
    const stdioProfile = launchSpec.stdioProfile ?? 'default';
    const factory = this.factories.get(stdioProfile);
    if (!factory) {
      const availableProfiles = [...this.factories.keys()].join(', ');
      throw new Error(
        `Unknown stdio profile "${stdioProfile}". Available profiles: ${availableProfiles}`,
      );
    }

    // 6. Spawn and return handle
    const detached = request.detached ?? launchSpec.detached;
    const childProcess = factory.spawn(spawnCommand, spawnArgs, {
      cwd: request.cwd,
      env: mergedEnv,
      signal: request.signal,
      ...(spawnUid !== undefined && { uid: spawnUid }),
      ...(spawnGid !== undefined && { gid: spawnGid }),
      ...(detached !== undefined && { detached }),
    });

    // 7. Register exit cleanup for credhelper session
    if (sessionId && this.credhelperClient) {
      const client = this.credhelperClient;
      const sid = sessionId;
      void childProcess.exitPromise.then(() => {
        client.endSession(sid).catch(() => {
          // endSession failures are logged but do not throw —
          // the daemon's sweeper handles cleanup for orphaned sessions
        });
      });
    }

    const outputParser = plugin.createOutputParser(intent);

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
