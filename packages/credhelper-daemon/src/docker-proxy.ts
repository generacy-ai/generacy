import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createDockerProxyHandler } from './docker-proxy-handler.js';
import { ContainerNameResolver } from './docker-name-resolver.js';
import type { DockerProxyConfig, DockerProxyHandle } from './types.js';

/**
 * Per-session Docker socket proxy. Creates a Unix socket at
 * `{sessionDir}/docker.sock` that mediates Docker API access
 * through the allowlist.
 */
export class DockerProxy implements DockerProxyHandle {
  private server: http.Server | null = null;
  private readonly nameResolver: ContainerNameResolver;
  private readonly socketPath: string;

  constructor(private readonly config: DockerProxyConfig) {
    this.nameResolver = new ContainerNameResolver(config.upstreamSocket);
    this.socketPath = path.join(config.sessionDir, 'docker.sock');
  }

  /** Start listening on the per-session Unix socket. */
  async start(): Promise<string> {
    const handler = createDockerProxyHandler({
      rules: this.config.rules,
      upstreamSocket: this.config.upstreamSocket,
      upstreamIsHost: this.config.upstreamIsHost,
      nameResolver: this.nameResolver,
      scratchDir: this.config.scratchDir,
    });

    this.server = http.createServer(handler);

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.socketPath, () => {
        // Set socket file mode to 0660
        fs.chmod(this.socketPath, 0o660).catch((err) => {
          console.warn(`[credhelper] Failed to set docker.sock mode: ${err}`);
        });
        resolve();
      });
    });

    return this.socketPath;
  }

  /** Stop the proxy, remove the socket file, and clear the name cache. */
  async stop(): Promise<void> {
    this.nameResolver.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    try {
      await fs.unlink(this.socketPath);
    } catch {
      // Socket file may already be cleaned up
    }
  }

  /** Get the path to the proxy socket. */
  getSocketPath(): string {
    return this.socketPath;
  }
}
