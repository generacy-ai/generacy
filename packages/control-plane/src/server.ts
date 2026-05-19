import http from 'node:http';
import fs from 'node:fs/promises';

import { extractActorContext } from './context.js';
import { ControlPlaneError, sendError } from './errors.js';
import { dispatch } from './router.js';
import { getCodeServerManager } from './services/code-server-manager.js';
import { getVsCodeTunnelManager } from './services/vscode-tunnel-manager.js';

export class ControlPlaneServer {
  private server: http.Server;
  private socketPath: string | undefined;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (err instanceof ControlPlaneError) {
          sendError(res, err);
        } else {
          sendError(
            res,
            new ControlPlaneError(
              'INTERNAL_ERROR',
              err instanceof Error ? err.message : 'Internal error',
            ),
          );
        }
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const actor = extractActorContext(req);
    await dispatch(req, res, actor);
  }

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;

    // Remove stale socket file if exists
    try {
      await fs.unlink(socketPath);
    } catch {
      // Ignore ENOENT
    }

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(socketPath, async () => {
        try {
          await fs.chmod(socketPath, 0o660);
        } catch {
          // Best-effort chmod
        }
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(async () => {
        try {
          await getCodeServerManager().shutdown();
        } catch {
          // Best-effort: don't block server shutdown on a wedged code-server child
        }
        try {
          await getVsCodeTunnelManager().shutdown();
        } catch {
          // Best-effort: don't block server shutdown on a wedged tunnel child
        }
        if (this.socketPath) {
          try {
            await fs.unlink(this.socketPath);
          } catch {
            // Ignore ENOENT
          }
        }
        resolve();
      });
    });
  }
}
