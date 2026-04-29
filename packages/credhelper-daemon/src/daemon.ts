import type { DaemonConfig, UpstreamDockerSocket } from './types.js';
import { CredentialStore } from './credential-store.js';
import { TokenRefresher } from './token-refresher.js';
import { ExposureRenderer } from './exposure-renderer.js';
import { SessionManager } from './session-manager.js';
import { ControlServer } from './control-server.js';
import { detectUpstreamSocket } from './docker-upstream.js';
import { AuditLog } from './audit/index.js';

/**
 * Top-level daemon orchestrator. Wires together all components and manages
 * lifecycle (start/stop).
 */
export class Daemon {
  private controlServer: ControlServer | null = null;
  private sessionManager: SessionManager | null = null;
  private refresher: TokenRefresher | null = null;
  private auditLog: AuditLog | null = null;

  constructor(private readonly config: DaemonConfig) {}

  async start(): Promise<void> {
    try {
      // Detect upstream Docker socket (fail-closed if unavailable)
      let upstreamDockerSocket: UpstreamDockerSocket | undefined;
      try {
        upstreamDockerSocket = await detectUpstreamSocket();
        console.log(
          `[credhelper] Docker upstream: ${upstreamDockerSocket.socketPath}` +
            (upstreamDockerSocket.isHost ? ' (host socket)' : ' (DinD)'),
        );
        if (upstreamDockerSocket.isHost) {
          console.warn(
            '[credhelper] SECURITY: upstream is host Docker socket — ' +
              'roles allowing POST /containers/create grant host filesystem access',
          );
        }
      } catch {
        // No Docker socket available — docker-socket-proxy exposures will fail at session time
        console.log('[credhelper] No Docker socket detected — docker proxy disabled');
      }

      // Create audit log (if cluster/worker identity is available)
      if (this.config.clusterId && this.config.workerId) {
        this.auditLog = new AuditLog({
          capacity: 5000,
          flushIntervalMs: 1000,
          maxBatchSize: 50,
          controlPlaneSocketPath: '/run/generacy-control-plane/control.sock',
          clusterId: this.config.clusterId,
          workerId: this.config.workerId,
        });
        this.auditLog.start();
        console.log('[credhelper] Audit log enabled');
      }

      // Create core components
      const store = new CredentialStore();
      this.refresher = new TokenRefresher(store);
      const renderer = new ExposureRenderer();

      this.sessionManager = new SessionManager(
        this.config.configLoader,
        this.config.pluginRegistry,
        this.config.backendFactory,
        store,
        this.refresher,
        renderer,
        {
          sessionsDir: this.config.sessionsDir,
          workerUid: this.config.workerUid,
          workerGid: this.config.workerGid,
          upstreamDockerSocket,
          scratchBaseDir: this.config.scratchBaseDir,
        },
        this.auditLog ?? undefined,
      );

      // Start expiry sweeper
      this.sessionManager.startSweeper(this.config.sweepIntervalMs);

      // Create and start control server
      this.controlServer = new ControlServer(
        this.sessionManager,
        this.config.workerUid,
        this.config.enablePeerCred,
      );
      await this.controlServer.start(this.config.controlSocketPath);

      console.log(
        `[credhelper] Daemon ready — control socket: ${this.config.controlSocketPath}`,
      );
    } catch (err) {
      console.error('[credhelper] Failed to start daemon:', err);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    console.log('[credhelper] Shutting down...');

    // Stop accepting connections
    if (this.controlServer) {
      await this.controlServer.close();
    }

    // End all sessions
    if (this.sessionManager) {
      this.sessionManager.stopSweeper();
      await this.sessionManager.endAll();
    }

    // Cancel all refresh timers
    if (this.refresher) {
      this.refresher.cancelAll();
    }

    // Flush remaining audit entries
    if (this.auditLog) {
      await this.auditLog.stop();
    }

    console.log('[credhelper] Shutdown complete');
  }

  /** Install SIGTERM handler for graceful shutdown. */
  installSignalHandlers(): void {
    process.on('SIGTERM', async () => {
      await this.stop();
      process.exit(0);
    });
  }
}
