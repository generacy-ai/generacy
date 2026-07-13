import http from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { probeControlPlaneSocket } from './control-plane-probe.js';

type ResumeServiceKind = 'vscode-tunnel' | 'code-server';

export interface BootResumeOptions {
  controlPlaneSocket?: string;
  controlPlaneWaitTimeout?: number;
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}

const DEFAULT_SOCKET = '/run/generacy-control-plane/control.sock';
const DEFAULT_WAIT_TIMEOUT = 15;

export class BootResumeService {
  private readonly controlPlaneSocket: string;
  private readonly controlPlaneWaitTimeout: number;
  private readonly logger: FastifyBaseLogger;
  private readonly sendRelayEvent?: (channel: string, payload: unknown) => void;

  constructor(options: BootResumeOptions) {
    this.controlPlaneSocket = options.controlPlaneSocket ?? DEFAULT_SOCKET;
    this.controlPlaneWaitTimeout = options.controlPlaneWaitTimeout ?? DEFAULT_WAIT_TIMEOUT;
    this.logger = options.logger;
    this.sendRelayEvent = options.sendRelayEvent;
  }

  async triggerBootResume(): Promise<void> {
    this.logger.info('Boot resume: waiting for control-plane socket');
    const ready = await this.waitForControlPlane();

    if (!ready) {
      this.handleResumeFailure('vscode-tunnel', 'Control-plane socket did not become ready');
      this.handleResumeFailure('code-server', 'Control-plane socket did not become ready');
      return;
    }

    this.logger.info('Boot resume: control-plane ready — dispatching lifecycle actions');

    await Promise.allSettled([
      this.sendLifecycleAction('vscode-tunnel').catch((err) =>
        this.handleResumeFailure('vscode-tunnel', err instanceof Error ? err.message : String(err)),
      ),
      this.sendLifecycleAction('code-server').catch((err) =>
        this.handleResumeFailure('code-server', err instanceof Error ? err.message : String(err)),
      ),
    ]);

    this.logger.info('Boot resume: both lifecycle actions dispatched');
  }

  private async waitForControlPlane(): Promise<boolean> {
    for (let elapsed = 0; elapsed < this.controlPlaneWaitTimeout; elapsed++) {
      const ready = await probeControlPlaneSocket(this.controlPlaneSocket);
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.logger.error(
      `Boot resume: control-plane socket not ready after ${this.controlPlaneWaitTimeout}s`,
    );
    return false;
  }

  private sendLifecycleAction(service: ResumeServiceKind): Promise<void> {
    const body = JSON.stringify({ action: `${service}-start` });

    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.controlPlaneSocket,
          path: `/lifecycle/${service}-start`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-generacy-actor-user-id': 'system',
            'x-generacy-actor-session-id': 'boot-resume',
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

  private handleResumeFailure(service: ResumeServiceKind, error: string): void {
    this.logger.error({ service, error }, 'Boot resume: lifecycle-action-failed');
    this.sendRelayEvent?.('cluster.bootstrap', {
      status: 'failed',
      reason: 'resume-failed',
      service,
      error,
    });
  }
}
