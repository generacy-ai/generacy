import type { ProcessFactory } from '../worker/types.js';
import type {
  AgentLaunchPlugin,
  LaunchHandle,
  LaunchRequest,
} from './types.js';
import type { CredhelperClient } from './credhelper-client.js';
import { applyCredentials } from './credentials-interceptor.js';
import { CredhelperUnavailableError } from './credhelper-errors.js';
import { DEFAULT_PROVIDER, SYSTEM_PROVIDER } from './constants.js';
import {
  DuplicatePluginRegistrationError,
  UnknownProviderError,
} from './errors.js';

/**
 * Plugin-based process launcher with tuple-keyed registry dispatch.
 *
 * Registry keys are composed as `${provider}:${kind}`. Callers may pass
 * `LaunchRequest.provider` to select a plugin; if omitted, resolves to
 * `DEFAULT_PROVIDER`. For kinds only the internal `SYSTEM_PROVIDER` claims,
 * a default-provider request falls back to the system plugin (call-site parity).
 */
export class AgentLauncher {
  private readonly registry = new Map<string, AgentLaunchPlugin>();
  private readonly credhelperClient?: CredhelperClient;

  constructor(
    private readonly factories: Map<string, ProcessFactory>,
    credhelperClient?: CredhelperClient,
  ) {
    this.credhelperClient = credhelperClient;
  }

  /**
   * Register a plugin for each of its supported kinds under (provider, kind).
   * Throws DuplicatePluginRegistrationError on duplicate key.
   */
  registerPlugin(plugin: AgentLaunchPlugin): void {
    if (typeof plugin.provider !== 'string' || plugin.provider.length === 0) {
      throw new Error(
        `Plugin "${plugin.pluginId}" must declare a non-empty provider string`,
      );
    }
    for (const kind of plugin.supportedKinds) {
      const key = `${plugin.provider}:${kind}`;
      const existing = this.registry.get(key);
      if (existing) {
        throw new DuplicatePluginRegistrationError(
          plugin.provider,
          kind,
          existing.pluginId,
        );
      }
      this.registry.set(key, plugin);
    }
  }

  /**
   * Launch a process based on the request's intent + provider.
   *
   * 1. Resolve provider (request.provider ?? DEFAULT_PROVIDER)
   * 2. Look up plugin by `${provider}:${kind}`; else fall back to
   *    `${SYSTEM_PROVIDER}:${kind}` when provider was defaulted
   * 3. Otherwise classify miss: known-provider-unknown-kind (Error)
   *    vs. unknown-provider (UnknownProviderError)
   * 4. Merge env, apply credentials, select factory, spawn.
   */
  async launch(request: LaunchRequest): Promise<LaunchHandle> {
    const { intent } = request;
    const provider = request.provider ?? DEFAULT_PROVIDER;
    const kind = intent.kind;
    const key = `${provider}:${kind}`;

    // 1. Resolve plugin
    let plugin = this.registry.get(key);
    if (!plugin && request.provider === undefined) {
      // Default-provider fallback: system-owned kinds (generic-subprocess, shell)
      // resolve without callers needing to spell 'system'.
      plugin = this.registry.get(`${SYSTEM_PROVIDER}:${kind}`);
    }
    if (!plugin) {
      const registryKeys = [...this.registry.keys()];
      const kindsForProvider: string[] = [];
      const providers = new Set<string>();
      for (const registryKey of registryKeys) {
        const [keyProvider, keyKind] = splitKey(registryKey);
        providers.add(keyProvider);
        if (keyProvider === provider) {
          kindsForProvider.push(keyKind);
        }
      }
      if (kindsForProvider.length > 0) {
        throw new Error(
          `Unknown intent kind "${kind}" for provider "${provider}". Known kinds for this provider: ${kindsForProvider.join(', ')}`,
        );
      }
      const availableProviders = [...providers].sort();
      throw new UnknownProviderError(provider, kind, availableProviders);
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

/** Split a `${provider}:${kind}` registry key. Provider is everything before the first colon. */
function splitKey(key: string): [string, string] {
  const colonIndex = key.indexOf(':');
  return [key.slice(0, colonIndex), key.slice(colonIndex + 1)];
}
