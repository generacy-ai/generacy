import { existsSync } from 'node:fs';
import http from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { probeControlPlaneSocket } from './control-plane-probe.js';
import { StatusReporter } from './status-reporter.js';

export interface PostActivationState {
  activated: boolean;
  postActivationComplete: boolean;
  needsRetry: boolean;
}

export interface PostActivationRetryOptions {
  completionFlagPath?: string;
  keyFilePath?: string;
  controlPlaneSocket?: string;
  controlPlaneWaitTimeout?: number;
  logger: FastifyBaseLogger;
  /** Function to send relay events (e.g. via relay client or IPC) */
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}

const DEFAULT_COMPLETION_FLAG = '/var/lib/generacy/post-activation-complete';
const DEFAULT_KEY_FILE = '/var/lib/generacy/cluster-api-key';
const DEFAULT_SOCKET = '/run/generacy-control-plane/control.sock';
const DEFAULT_WAIT_TIMEOUT = 15;

export class PostActivationRetryService {
  private readonly completionFlagPath: string;
  private readonly keyFilePath: string;
  private readonly controlPlaneSocket: string;
  private readonly controlPlaneWaitTimeout: number;
  private readonly logger: FastifyBaseLogger;
  private readonly sendRelayEvent?: (channel: string, payload: unknown) => void;
  private readonly statusReporter: StatusReporter;

  constructor(options: PostActivationRetryOptions) {
    this.completionFlagPath = options.completionFlagPath ?? DEFAULT_COMPLETION_FLAG;
    this.keyFilePath = options.keyFilePath ?? DEFAULT_KEY_FILE;
    this.controlPlaneSocket = options.controlPlaneSocket ?? DEFAULT_SOCKET;
    this.controlPlaneWaitTimeout = options.controlPlaneWaitTimeout ?? DEFAULT_WAIT_TIMEOUT;
    this.logger = options.logger;
    this.sendRelayEvent = options.sendRelayEvent;
    this.statusReporter = new StatusReporter({ socketPath: this.controlPlaneSocket });
  }

  checkPostActivationState(): PostActivationState {
    const activated = existsSync(this.keyFilePath);
    const postActivationComplete = existsSync(this.completionFlagPath);
    return {
      activated,
      postActivationComplete,
      needsRetry: activated && !postActivationComplete,
    };
  }

  async triggerPostActivationRetry(): Promise<void> {
    this.logger.info('Post-activation incomplete — waiting for control-plane socket');

    // Emit retrying event
    this.sendRelayEvent?.('cluster.bootstrap', {
      status: 'retrying',
      reason: 'post-activation-incomplete',
      attempt: 'restart',
    });

    // Wait for control-plane socket
    let ready = false;
    for (let elapsed = 0; elapsed < this.controlPlaneWaitTimeout; elapsed++) {
      ready = await probeControlPlaneSocket(this.controlPlaneSocket);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!ready) {
      const reason = 'control-plane-unreachable';
      this.logger.error(`Post-activation retry aborted: control-plane socket not ready after ${this.controlPlaneWaitTimeout}s`);
      await this.handleRetryFailure(reason, 'Control-plane socket did not become ready');
      return;
    }

    this.logger.info('Control-plane ready — replaying bootstrap-complete lifecycle action');

    try {
      await this.sendLifecycleAction();
      this.logger.info('Post-activation retry: bootstrap-complete lifecycle action sent');
    } catch (err) {
      const reason = 'lifecycle-action-failed';
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, `Post-activation retry failed: ${errorMsg}`);
      await this.handleRetryFailure(reason, errorMsg);
    }
  }

  private async handleRetryFailure(reason: string, error: string): Promise<void> {
    const statusReason = `post-activation failed on restart: ${error}`;
    await this.statusReporter.pushStatus('degraded', statusReason);

    this.sendRelayEvent?.('cluster.bootstrap', {
      status: 'failed',
      reason,
      error,
    });
  }

  private sendLifecycleAction(): Promise<void> {
    const body = JSON.stringify({ action: 'bootstrap-complete' });

    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.controlPlaneSocket,
          path: '/lifecycle/bootstrap-complete',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-generacy-actor-user-id': 'system',
            'x-generacy-actor-session-id': 'post-activation-retry',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Lifecycle action returned ${res.statusCode}: ${data}`));
            }
          });
        },
      );

      req.setTimeout(10_000, () => {
        req.destroy();
        reject(new Error('Lifecycle action request timed out'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}
