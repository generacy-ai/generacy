import path from 'node:path';

import type {
  ConfigLoader,
  PluginRegistry,
  SessionState,
  CredentialCacheEntry,
  DaemonConfig,
  DockerProxyHandle,
  LocalhostProxyHandle,
  UpstreamDockerSocket,
} from './types.js';
import type { BackendClientFactory } from './backends/types.js';
import { CredhelperError } from './errors.js';
import { CredentialStore } from './credential-store.js';
import { TokenRefresher } from './token-refresher.js';
import { ExposureRenderer } from './exposure-renderer.js';
import { createDataServer } from './data-server.js';
import { rmSafe } from './util/fs.js';
import { parseTtl } from './util/parse-ttl.js';
import type { AuditLog } from './audit/index.js';
import { createScratchDir, removeScratchDir, DEFAULT_SCRATCH_BASE } from './scratch-directory.js';

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly pluginRegistry: PluginRegistry,
    private readonly backendFactory: BackendClientFactory,
    private readonly store: CredentialStore,
    private readonly refresher: TokenRefresher,
    private readonly renderer: ExposureRenderer,
    private readonly config: Pick<DaemonConfig, 'sessionsDir' | 'workerUid' | 'workerGid'> & {
      upstreamDockerSocket?: UpstreamDockerSocket;
      scratchBaseDir?: string;
    },
    private readonly auditLog?: AuditLog,
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

    // Validate proxy config: any credential with localhost-proxy exposure
    // must have a matching proxy:<ref> entry in the role config.
    for (const credRef of roleConfig.credentials) {
      for (const expose of credRef.expose) {
        if (expose.as === 'localhost-proxy') {
          if (!roleConfig.proxy?.[credRef.ref]) {
            throw new CredhelperError(
              'PROXY_CONFIG_MISSING',
              `Role ${role} uses localhost-proxy exposure for credential ${credRef.ref} but has no proxy.${credRef.ref} config`,
              { roleId: role, credentialRef: credRef.ref },
            );
          }
        }
      }
    }

    this.auditLog?.record({
      action: 'session.begin',
      sessionId,
      role,
      success: true,
    });

    const sessionDir = path.join(this.config.sessionsDir, sessionId);
    const dataSocketPath = path.join(sessionDir, 'data.sock');
    const credentialIds: string[] = [];
    let dockerProxy: DockerProxyHandle | undefined;
    const localhostProxies: LocalhostProxyHandle[] = [];
    const envEntries: Array<{ key: string; value: string }> = [];
    let scratchDir: string | undefined;

    // Create session directory
    await this.renderer.renderSessionDir(sessionDir);

    // Create per-session scratch directory
    scratchDir = await createScratchDir(
      sessionId,
      this.config.workerUid,
      this.config.workerGid,
      this.config.scratchBaseDir ?? DEFAULT_SCRATCH_BASE,
    );

    // Resolve/mint each credential and render exposures
    let latestExpiry = new Date(Date.now() + 3600000); // default 1h

    for (const credRef of roleConfig.credentials) {
      const credEntry = await this.configLoader.loadCredential(credRef.ref);
      const plugin = this.pluginRegistry.getPlugin(credEntry.type);
      credentialIds.push(credRef.ref);

      // Extract plugin-specific config by stripping common structural fields
      const { id: _id, type: _type, backend: _backend, backendKey: _backendKey, mint: _mint, ...credConfig } = credEntry;

      let credValue;
      let expiresAt: Date;

      // Load backend config and create client (shared by mint and resolve paths)
      const backendEntry = await this.configLoader.loadBackend(credEntry.backend);
      const backendClient = this.backendFactory.create(backendEntry);

      if (credEntry.mint && plugin.mint) {
        // Mint-based credential
        const ttlMs = parseTtl(credEntry.mint.ttl);

        try {
          const result = await plugin.mint({
            credentialId: credRef.ref,
            backendKey: credEntry.backendKey,
            backend: backendClient,
            scope: credRef.scope ?? credEntry.mint.scopeTemplate ?? {},
            ttl: ttlMs,
            config: credConfig,
          });
          credValue = result.value;
          expiresAt = result.expiresAt;
          this.auditLog?.record({
            action: 'credential.mint',
            sessionId,
            credentialId: credRef.ref,
            role,
            pluginId: credEntry.type,
            success: true,
          });
        } catch (err) {
          this.auditLog?.record({
            action: 'credential.mint',
            sessionId,
            credentialId: credRef.ref,
            role,
            pluginId: credEntry.type,
            success: false,
            errorCode: err instanceof CredhelperError ? err.code : 'UNKNOWN',
          });
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
            backend: backendClient,
            scope: credRef.scope ?? {},
            ttl: ttlMs,
            config: credConfig,
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
              backend: backendClient,
              scope: credRef.scope ?? {},
              ttl: ttlMs,
              config: credConfig,
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
            backend: backendClient,
            config: credConfig,
          });
          this.auditLog?.record({
            action: 'credential.resolve',
            sessionId,
            credentialId: credRef.ref,
            role,
            pluginId: credEntry.type,
            success: true,
          });
        } catch (err) {
          this.auditLog?.record({
            action: 'credential.resolve',
            sessionId,
            credentialId: credRef.ref,
            role,
            pluginId: credEntry.type,
            success: false,
            errorCode: err instanceof CredhelperError ? err.code : 'UNKNOWN',
          });
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

      // Render exposures — call plugin.renderExposure() for credential-specific data,
      // then renderer.renderPluginExposure() to wrap with session infrastructure.
      for (const expose of credRef.expose) {
        if (!plugin.supportedExposures.includes(expose.as)) {
          throw new CredhelperError(
            'UNSUPPORTED_EXPOSURE',
            `Plugin ${credEntry.type} does not support exposure ${expose.as}`,
            { pluginType: credEntry.type, exposureKind: expose.as },
          );
        }

        // localhost-proxy: create a real reverse proxy with allowlist enforcement
        if (expose.as === 'localhost-proxy') {
          const proxyConfig = roleConfig.proxy![credRef.ref]!;
          const port = expose.port ?? 0;

          // Get plugin's exposure data for auth headers
          const exposureCfg = { kind: 'localhost-proxy' as const, port };
          const exposureData = plugin.renderExposure(expose.as, credValue, exposureCfg);

          if (exposureData.kind !== 'localhost-proxy') {
            throw new CredhelperError(
              'INTERNAL_ERROR',
              `Plugin returned unexpected exposure kind: ${exposureData.kind}`,
            );
          }

          const handle = await this.renderer.renderLocalhostProxy(
            sessionDir,
            { upstream: exposureData.upstream, headers: exposureData.headers },
            proxyConfig.allow,
            port,
          );
          localhostProxies.push(handle);

          // Write env var for proxy URL
          const envName = (expose as { envName?: string }).envName ?? `${credRef.ref.toUpperCase().replace(/-/g, '_')}_PROXY_URL`;
          envEntries.push({ key: envName, value: `http://127.0.0.1:${port}` });
          continue;
        }

        // docker-socket-proxy is not plugin-rendered: it's infrastructure
        // owned by the daemon and shared across credentials in a session.
        if (expose.as === 'docker-socket-proxy') {
          if (!this.config.upstreamDockerSocket) {
            throw new CredhelperError(
              'DOCKER_UPSTREAM_NOT_FOUND',
              'docker-socket-proxy exposure requires a Docker socket, but none was detected at boot',
            );
          }
          if (!roleConfig.docker?.allow) {
            throw new CredhelperError(
              'INVALID_ROLE',
              `Role ${role} uses docker-socket-proxy exposure but has no docker.allow rules`,
              { roleId: role },
            );
          }
          if (!dockerProxy) {
            const result = await this.renderer.renderDockerSocketProxy(
              sessionDir,
              roleConfig.docker.allow,
              this.config.upstreamDockerSocket.socketPath,
              this.config.upstreamDockerSocket.isHost,
              sessionId,
              scratchDir,
            );
            dockerProxy = result.proxy;
          }
          continue;
        }

        // file exposure: render the file and track for session cleanup
        if (expose.as === 'file') {
          const filePath = (expose as { path?: string }).path;
          if (!filePath) {
            throw new CredhelperError(
              'INVALID_ROLE',
              `File exposure for credential ${credRef.ref} missing required 'path' field`,
              { credentialRef: credRef.ref },
            );
          }
          const fileMode = (expose as { mode?: number }).mode;
          const exposureCfg = { kind: 'file' as const, path: filePath, mode: fileMode };
          const exposureData = plugin.renderExposure(expose.as, credValue, exposureCfg);

          await this.renderer.renderPluginExposure(sessionDir, dataSocketPath, credRef.ref, exposureData);
          this.renderer.trackFileForSession(sessionId, filePath);

          this.auditLog?.record({
            action: 'exposure.render',
            sessionId,
            credentialId: credRef.ref,
            role,
            pluginId: credEntry.type,
            exposureKind: expose.as,
            success: true,
          });
          continue;
        }

        // Build ExposureConfig for this kind (localhost-proxy and docker-socket-proxy
        // are handled above with continue, so only env/git/gcloud reach here)
        const exposureCfg = expose.as === 'env'
          ? { kind: 'env' as const, name: expose.name ?? credRef.ref.toUpperCase().replace(/-/g, '_') }
          : { kind: expose.as } as import('@generacy-ai/credhelper').ExposureConfig;

        // Plugin renders credential-specific data
        const exposureData = plugin.renderExposure(expose.as, credValue, exposureCfg);

        // Renderer wraps with session infrastructure (socket paths, file layout)
        await this.renderer.renderPluginExposure(sessionDir, dataSocketPath, credRef.ref, exposureData);

        this.auditLog?.record({
          action: 'exposure.render',
          sessionId,
          credentialId: credRef.ref,
          role,
          pluginId: credEntry.type,
          exposureKind: expose.as,
          success: true,
        });
      }
    }

    // Add session env vars
    if (scratchDir) {
      envEntries.push({ key: 'GENERACY_SCRATCH_DIR', value: scratchDir });
    }
    if (dockerProxy) {
      const dockerSocketPath = path.join(sessionDir, 'docker.sock');
      envEntries.push({ key: 'DOCKER_HOST', value: `unix://${dockerSocketPath}` });
    }

    // Write all collected env vars
    if (envEntries.length > 0) {
      await this.renderer.renderEnv(sessionDir, envEntries);
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
      dockerProxy,
      localhostProxies: localhostProxies.length > 0 ? localhostProxies : undefined,
      scratchDir,
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

    // Stop localhost proxies if active
    if (session.localhostProxies) {
      for (const proxy of session.localhostProxies) {
        await proxy.stop();
      }
    }

    // Stop docker proxy if active
    if (session.dockerProxy) {
      await session.dockerProxy.stop();
    }

    // Clean session-scoped file exposures
    await this.renderer.cleanupSessionFiles(sessionId);

    // Clean scratch directory
    if (session.scratchDir) {
      await removeScratchDir(session.scratchDir);
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

    this.auditLog?.record({
      action: 'session.end',
      sessionId,
      role: session.roleId,
      success: true,
    });
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
