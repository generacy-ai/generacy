import path from 'node:path';

import type {
  ConfigLoader,
  PluginRegistry,
  SessionState,
  CredentialCacheEntry,
  DaemonConfig,
} from './types.js';
import { CredhelperError } from './errors.js';
import { CredentialStore } from './credential-store.js';
import { TokenRefresher } from './token-refresher.js';
import { ExposureRenderer } from './exposure-renderer.js';
import { createDataServer } from './data-server.js';
import { rmSafe } from './util/fs.js';
import { parseTtl } from './util/parse-ttl.js';

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly pluginRegistry: PluginRegistry,
    private readonly store: CredentialStore,
    private readonly refresher: TokenRefresher,
    private readonly renderer: ExposureRenderer,
    private readonly config: Pick<DaemonConfig, 'sessionsDir' | 'workerUid' | 'workerGid'>,
  ) {}

  async beginSession(request: {
    role: string;
    sessionId: string;
  }): Promise<{ sessionDir: string; expiresAt: Date }> {
    const { role, sessionId } = request;

    // Reject duplicate session IDs
    if (this.sessions.has(sessionId)) {
      throw new CredhelperError(
        'INVALID_REQUEST',
        `Session ${sessionId} already exists`,
        { sessionId },
      );
    }

    // Validate role
    let roleConfig;
    try {
      roleConfig = await this.configLoader.loadRole(role);
    } catch {
      throw new CredhelperError('ROLE_NOT_FOUND', `Role not found: ${role}`, {
        roleId: role,
      });
    }

    const sessionDir = path.join(this.config.sessionsDir, sessionId);
    const dataSocketPath = path.join(sessionDir, 'data.sock');
    const credentialIds: string[] = [];

    // Create session directory
    await this.renderer.renderSessionDir(sessionDir);

    // Resolve/mint each credential and render exposures
    let latestExpiry = new Date(Date.now() + 3600000); // default 1h

    for (const credRef of roleConfig.credentials) {
      const credEntry = await this.configLoader.loadCredential(credRef.ref);
      const plugin = this.pluginRegistry.getPlugin(credEntry.type);
      credentialIds.push(credRef.ref);

      let credValue;
      let expiresAt: Date;

      if (credEntry.mint && plugin.mint) {
        // Mint-based credential
        const ttlMs = parseTtl(credEntry.mint.ttl);
        const backend = await this.configLoader.loadBackend(credEntry.backend);

        try {
          const result = await plugin.mint({
            credentialId: credRef.ref,
            backendKey: credEntry.backendKey,
            backend: { fetchSecret: async () => '' }, // Stub — real backend client from #462
            scope: credRef.scope ?? credEntry.mint.scopeTemplate ?? {},
            ttl: ttlMs,
          });
          credValue = result.value;
          expiresAt = result.expiresAt;
        } catch (err) {
          throw new CredhelperError(
            'PLUGIN_MINT_FAILED',
            `Mint failed for credential ${credRef.ref}: ${err instanceof Error ? err.message : String(err)}`,
            { credentialId: credRef.ref, pluginType: credEntry.type },
          );
        }

        // Store credential
        const entry: CredentialCacheEntry = {
          value: credValue,
          expiresAt,
          available: true,
          credentialType: credEntry.type,
          mintContext: {
            credentialId: credRef.ref,
            backendKey: credEntry.backendKey,
            backend: { fetchSecret: async () => '' },
            scope: credRef.scope ?? {},
            ttl: ttlMs,
          },
        };
        this.store.set(sessionId, credRef.ref, entry);

        // Schedule background refresh
        this.refresher.scheduleRefresh(
          sessionId,
          credRef.ref,
          ttlMs,
          async () => {
            const result = await plugin.mint!({
              credentialId: credRef.ref,
              backendKey: credEntry.backendKey,
              backend: { fetchSecret: async () => '' },
              scope: credRef.scope ?? {},
              ttl: ttlMs,
            });
            return result;
          },
        );
      } else if (plugin.resolve) {
        // Resolve-based credential (static secret)
        try {
          credValue = await plugin.resolve({
            credentialId: credRef.ref,
            backendKey: credEntry.backendKey,
            backend: { fetchSecret: async () => '' },
          });
        } catch (err) {
          throw new CredhelperError(
            'PLUGIN_RESOLVE_FAILED',
            `Resolve failed for credential ${credRef.ref}: ${err instanceof Error ? err.message : String(err)}`,
            { credentialId: credRef.ref, pluginType: credEntry.type },
          );
        }
        expiresAt = new Date(Date.now() + 86400000); // 24h for resolve-based

        const entry: CredentialCacheEntry = {
          value: credValue,
          expiresAt,
          available: true,
          credentialType: credEntry.type,
        };
        this.store.set(sessionId, credRef.ref, entry);
      } else {
        throw new CredhelperError(
          'PLUGIN_NOT_FOUND',
          `Plugin for type ${credEntry.type} supports neither mint nor resolve`,
          { pluginType: credEntry.type },
        );
      }

      // Track latest expiry
      if (expiresAt > latestExpiry) {
        latestExpiry = expiresAt;
      }

      // Render exposures
      for (const expose of credRef.expose) {
        if (!plugin.supportedExposures.includes(expose.as)) {
          throw new CredhelperError(
            'UNSUPPORTED_EXPOSURE',
            `Plugin ${credEntry.type} does not support exposure ${expose.as}`,
            { pluginType: credEntry.type, exposureKind: expose.as },
          );
        }

        switch (expose.as) {
          case 'env': {
            const output = plugin.renderExposure(expose.as, credValue, {
              kind: 'env',
              name: expose.name ?? credRef.ref.toUpperCase().replace(/-/g, '_'),
            });
            if (output.kind === 'env') {
              await this.renderer.renderEnv(sessionDir, output.entries);
            }
            break;
          }
          case 'git-credential-helper':
            await this.renderer.renderGitCredentialHelper(
              sessionDir,
              dataSocketPath,
            );
            break;
          case 'gcloud-external-account':
            await this.renderer.renderGcloudExternalAccount(
              sessionDir,
              dataSocketPath,
              credRef.ref,
            );
            break;
          case 'localhost-proxy':
            this.renderer.renderLocalhostProxy();
            break;
          case 'docker-socket-proxy':
            this.renderer.renderDockerSocketProxy();
            break;
        }
      }
    }

    // Start data server for this session
    const dataServer = createDataServer(sessionId, this.store, dataSocketPath);
    await new Promise<void>((resolve, reject) => {
      dataServer.on('error', reject);
      dataServer.listen(dataSocketPath, () => resolve());
    });

    // Store session state
    const session: SessionState = {
      sessionId,
      roleId: role,
      sessionDir,
      expiresAt: latestExpiry,
      createdAt: new Date(),
      dataServer,
      dataSocketPath,
      credentialIds,
    };
    this.sessions.set(sessionId, session);

    return { sessionDir, expiresAt: latestExpiry };
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new CredhelperError(
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
        { sessionId },
      );
    }

    // Cancel refresh timers
    this.refresher.cancelSession(sessionId);

    // Close data server
    await new Promise<void>((resolve) => {
      session.dataServer.close(() => resolve());
    });

    // Clear credential store
    this.store.clearSession(sessionId);

    // Wipe session directory
    await rmSafe(session.sessionDir);

    // Remove from active sessions
    this.sessions.delete(sessionId);
  }

  async endAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      try {
        await this.endSession(sessionId);
      } catch {
        // Best effort cleanup during shutdown
      }
    }
  }

  getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new CredhelperError(
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
        { sessionId },
      );
    }
    return session;
  }

  /** Start the expiry sweeper interval. */
  startSweeper(intervalMs: number): void {
    this.sweepTimer = setInterval(() => {
      const now = new Date();
      for (const [sessionId, session] of this.sessions) {
        if (session.expiresAt < now) {
          console.warn(
            `[credhelper] Session ${sessionId} expired, auto-cleaning`,
          );
          this.endSession(sessionId).catch((err) => {
            console.error(
              `[credhelper] Failed to clean expired session ${sessionId}:`,
              err,
            );
          });
        }
      }
    }, intervalMs);
  }

  /** Stop the expiry sweeper. */
  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
