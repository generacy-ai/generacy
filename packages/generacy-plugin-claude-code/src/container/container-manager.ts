/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Container manager for Docker container lifecycle management.
 * Handles creating, starting, attaching, and cleaning up containers.
 */

import Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';
import type { Logger } from 'pino';
import { ContainerStartError, ContainerNotRunningError, wrapError } from '../errors.js';
import type { ContainerConfig } from '../types.js';
import type {
  ManagedContainer,
  ContainerState,
  ContainerStreams,
  CreateContainerOptions,
  StartContainerOptions,
  StopContainerOptions,
  AttachOptions,
  ExecResult,
  HealthCheckResult,
} from './types.js';
import {
  DEFAULT_CONTAINER_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_SECONDS,
} from './types.js';

/**
 * Manages Docker container lifecycle for Claude Code sessions.
 */
export class ContainerManager {
  private readonly docker: Docker;
  private readonly logger: Logger;
  private readonly containers: Map<string, ManagedContainer> = new Map();

  constructor(docker: Docker, logger: Logger) {
    this.docker = docker;
    this.logger = logger.child({ component: 'ContainerManager' });
  }

  /**
   * Create a new container for a session.
   */
  async create(options: CreateContainerOptions): Promise<ManagedContainer> {
    const { sessionId, config } = options;

    this.logger.info({ sessionId, image: config.image }, 'Creating container');

    const createOptions = this.buildCreateOptions(sessionId, config);

    try {
      const container = await this.docker.createContainer(createOptions);
      const containerId = container.id;

      const managedContainer: ManagedContainer = {
        containerId,
        sessionId,
        config,
        state: { status: 'created', containerId },
        health: { status: 'unknown', failureCount: 0 },
        createdAt: new Date(),
      };

      this.containers.set(sessionId, managedContainer);

      this.logger.info({ sessionId, containerId }, 'Container created');

      return managedContainer;
    } catch (error) {
      const wrappedError = wrapError(error);
      this.logger.error({ sessionId, error: wrappedError }, 'Failed to create container');
      throw new ContainerStartError(config.image, wrappedError.message);
    }
  }

  /**
   * Start a container.
   */
  async start(
    sessionId: string,
    options: StartContainerOptions = {}
  ): Promise<ManagedContainer> {
    const managed = this.getContainer(sessionId);
    const { containerId } = managed;

    this.logger.info({ sessionId, containerId }, 'Starting container');

    this.updateState(sessionId, { status: 'starting', containerId });

    try {
      const container = this.docker.getContainer(containerId);
      await container.start();

      this.updateState(sessionId, {
        status: 'running',
        containerId,
        startedAt: new Date(),
      });

      this.logger.info({ sessionId, containerId }, 'Container started');

      if (options.waitForHealthy) {
        await this.waitForHealthy(
          sessionId,
          options.timeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS
        );
      }

      return this.getContainer(sessionId);
    } catch (error) {
      const wrappedError = wrapError(error);
      this.updateState(sessionId, {
        status: 'error',
        containerId,
        error: wrappedError.message,
      });
      this.logger.error({ sessionId, containerId, error: wrappedError }, 'Failed to start container');
      throw new ContainerStartError(managed.config.image, wrappedError.message);
    }
  }

  /**
   * Attach to a container's I/O streams.
   */
  async attach(
    sessionId: string,
    options: AttachOptions = { stdin: true, stdout: true, stderr: true, stream: true }
  ): Promise<ContainerStreams> {
    const managed = this.getContainer(sessionId);

    if (managed.state.status !== 'running') {
      throw new ContainerNotRunningError(sessionId, managed.containerId);
    }

    this.logger.debug({ sessionId, containerId: managed.containerId }, 'Attaching to container');

    const container = this.docker.getContainer(managed.containerId);

    const attachStream = await container.attach({
      stream: options.stream ?? true,
      stdin: options.stdin ?? true,
      stdout: options.stdout ?? true,
      stderr: options.stderr ?? true,
      hijack: options.hijack ?? true,
    });

    // Dockerode returns a single duplex stream for hijacked connections
    // We need to demultiplex stdout and stderr from the combined stream
    const streams: ContainerStreams = {
      stdin: attachStream,
      stdout: attachStream,
      stderr: attachStream,
    };

    managed.streams = streams;

    this.logger.debug({ sessionId, containerId: managed.containerId }, 'Attached to container');

    return streams;
  }

  /**
   * Execute a command in a running container.
   */
  async exec(
    sessionId: string,
    cmd: string[],
    options: { timeout?: number } = {}
  ): Promise<ExecResult> {
    const managed = this.getContainer(sessionId);

    if (managed.state.status !== 'running') {
      throw new ContainerNotRunningError(sessionId, managed.containerId);
    }

    this.logger.debug({ sessionId, cmd }, 'Executing command in container');

    const container = this.docker.getContainer(managed.containerId);

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const execStream = await exec.start({ hijack: true, stdin: false });

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = options.timeout ?? DEFAULT_CONTAINER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        execStream.destroy();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      // Demultiplex the stream
      const chunks: Buffer[] = [];

      execStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      execStream.on('end', async () => {
        if (timedOut) return;
        clearTimeout(timer);

        // Parse the multiplexed stream
        const combined = Buffer.concat(chunks);
        const { stdout: out, stderr: err } = this.demuxStream(combined);
        stdout = out;
        stderr = err;

        try {
          const inspect = await exec.inspect();
          resolve({
            exitCode: inspect.ExitCode ?? 0,
            stdout,
            stderr,
          });
        } catch (error) {
          resolve({
            exitCode: -1,
            stdout,
            stderr,
          });
        }
      });

      execStream.on('error', (error: Error) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Stop a container.
   */
  async stop(
    sessionId: string,
    options: StopContainerOptions = {}
  ): Promise<void> {
    const managed = this.containers.get(sessionId);

    if (!managed) {
      this.logger.warn({ sessionId }, 'Container not found for stop');
      return;
    }

    const { containerId } = managed;

    if (managed.state.status === 'stopped' || managed.state.status === 'error') {
      this.logger.debug({ sessionId, containerId }, 'Container already stopped');
      return;
    }

    this.logger.info({ sessionId, containerId }, 'Stopping container');

    this.updateState(sessionId, { status: 'stopping', containerId });

    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({
        t: options.timeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS,
      });

      const inspect = await container.inspect();
      const exitCode = inspect.State.ExitCode;

      this.updateState(sessionId, {
        status: 'stopped',
        containerId,
        stoppedAt: new Date(),
        exitCode,
      });

      this.logger.info({ sessionId, containerId, exitCode }, 'Container stopped');

      if (options.remove) {
        await this.remove(sessionId);
      }
    } catch (error) {
      // Container might already be stopped
      const wrappedError = wrapError(error);
      if (wrappedError.message.includes('is not running')) {
        this.updateState(sessionId, {
          status: 'stopped',
          containerId,
          stoppedAt: new Date(),
        });
      } else {
        this.updateState(sessionId, {
          status: 'error',
          containerId,
          error: wrappedError.message,
        });
        throw wrappedError;
      }
    }
  }

  /**
   * Remove a container.
   */
  async remove(sessionId: string): Promise<void> {
    const managed = this.containers.get(sessionId);

    if (!managed) {
      return;
    }

    this.logger.info({ sessionId, containerId: managed.containerId }, 'Removing container');

    try {
      const container = this.docker.getContainer(managed.containerId);
      await container.remove({ force: true });
    } catch (error) {
      // Ignore errors if container doesn't exist
      const wrappedError = wrapError(error);
      if (!wrappedError.message.includes('No such container')) {
        this.logger.warn({ sessionId, error: wrappedError }, 'Failed to remove container');
      }
    }

    this.containers.delete(sessionId);

    this.logger.info({ sessionId }, 'Container removed');
  }

  /**
   * Clean up all containers.
   */
  async cleanup(): Promise<void> {
    this.logger.info({ count: this.containers.size }, 'Cleaning up all containers');

    const sessionIds = Array.from(this.containers.keys());

    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await this.stop(sessionId, { remove: true });
        } catch (error) {
          this.logger.warn({ sessionId, error }, 'Failed to cleanup container');
        }
      })
    );
  }

  /**
   * Get container info for a session.
   */
  getContainer(sessionId: string): ManagedContainer {
    const managed = this.containers.get(sessionId);

    if (!managed) {
      throw new ContainerNotRunningError(sessionId);
    }

    return managed;
  }

  /**
   * Check if a container exists for a session.
   */
  hasContainer(sessionId: string): boolean {
    return this.containers.has(sessionId);
  }

  /**
   * Get the current state of a container.
   */
  getState(sessionId: string): ContainerState | undefined {
    return this.containers.get(sessionId)?.state;
  }

  /**
   * Check container health.
   */
  async checkHealth(sessionId: string): Promise<HealthCheckResult> {
    const managed = this.getContainer(sessionId);

    if (managed.state.status !== 'running') {
      return {
        status: 'unknown',
        failureCount: 0,
      };
    }

    try {
      const container = this.docker.getContainer(managed.containerId);
      const inspect = await container.inspect();

      const health = inspect.State.Health;

      if (!health) {
        return {
          status: 'unknown',
          failureCount: 0,
        };
      }

      const result: HealthCheckResult = {
        status: health.Status as HealthCheckResult['status'],
        lastCheck: new Date(),
        failureCount: health.FailingStreak ?? 0,
        lastError: health.Log?.[health.Log.length - 1]?.Output,
      };

      managed.health = result;

      return result;
    } catch (error) {
      const wrappedError = wrapError(error);
      return {
        status: 'unhealthy',
        lastCheck: new Date(),
        failureCount: managed.health.failureCount + 1,
        lastError: wrappedError.message,
      };
    }
  }

  /**
   * Wait for a container to become healthy.
   */
  private async waitForHealthy(sessionId: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const health = await this.checkHealth(sessionId);

      if (health.status === 'healthy') {
        return;
      }

      if (health.status === 'unhealthy') {
        throw new ContainerStartError(
          this.getContainer(sessionId).config.image,
          `Container became unhealthy: ${health.lastError}`
        );
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new ContainerStartError(
      this.getContainer(sessionId).config.image,
      `Container health check timed out after ${timeoutMs}ms`
    );
  }

  /**
   * Build Docker container create options from config.
   */
  private buildCreateOptions(
    sessionId: string,
    config: ContainerConfig
  ): ContainerCreateOptions {
    const options: ContainerCreateOptions = {
      Image: config.image,
      WorkingDir: config.workdir,
      Env: Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
      Labels: {
        'generacy.session.id': sessionId,
        'generacy.managed': 'true',
      },
      HostConfig: {
        NetworkMode: config.network,
        Binds: config.mounts.map((mount) => {
          const mode = mount.readonly ? ':ro' : '';
          return `${mount.source}:${mount.target}${mode}`;
        }),
      },
      // Keep stdin open for interactive use
      OpenStdin: true,
      StdinOnce: false,
      Tty: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    };

    // Apply resource limits if specified
    if (config.resources) {
      options.HostConfig = {
        ...options.HostConfig,
        Memory: config.resources.memory,
        NanoCpus: config.resources.cpus
          ? Math.round(config.resources.cpus * 1e9)
          : undefined,
      };
    }

    return options;
  }

  /**
   * Update container state.
   */
  private updateState(sessionId: string, state: ContainerState): void {
    const managed = this.containers.get(sessionId);

    if (managed) {
      managed.state = state;
    }
  }

  /**
   * Demultiplex Docker stream into stdout and stderr.
   * Docker streams have an 8-byte header: [type, 0, 0, 0, size (4 bytes)]
   */
  private demuxStream(data: Buffer): { stdout: string; stderr: string } {
    let stdout = '';
    let stderr = '';
    let offset = 0;

    while (offset < data.length) {
      if (offset + 8 > data.length) break;

      const type = data[offset];
      const size = data.readUInt32BE(offset + 4);

      if (offset + 8 + size > data.length) break;

      const content = data.subarray(offset + 8, offset + 8 + size).toString('utf8');

      if (type === 1) {
        stdout += content;
      } else if (type === 2) {
        stderr += content;
      }

      offset += 8 + size;
    }

    return { stdout, stderr };
  }
}
