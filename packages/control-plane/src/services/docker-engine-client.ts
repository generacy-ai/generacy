import http, { type IncomingMessage } from 'node:http';
import {
  type ContainerSummary,
  type ContainerInspect,
  type ContainerCreateBody,
  type NetworkConnectBody,
  type EngineEvent,
  DockerEngineError,
  DockerDaemonUnavailableError,
} from './docker-engine-types.js';

const DEFAULT_DOCKER_HOST = 'unix:///var/run/docker-host.sock';
const DEFAULT_REQUEST_TIMEOUT = 30_000;

export interface DockerEngineClientOptions {
  /** Docker socket spec. Default: env DOCKER_HOST or unix:///var/run/docker-host.sock. */
  dockerHost?: string;
  /** Request timeout in ms. Default: 30000. */
  requestTimeout?: number;
}

export interface ListContainersOptions {
  /** Compose-style label filters: { 'com.docker.compose.project': ['<name>'] }. */
  filters?: Record<string, string[]>;
  /** Include stopped containers. */
  all?: boolean;
}

export interface CreateContainerResponse {
  Id: string;
  Warnings?: string[];
}

export interface StreamContainerEventsOptions {
  filters: {
    label?: string[];
    type?: (
      | 'container'
      | 'image'
      | 'network'
      | 'volume'
      | 'service'
      | 'node'
      | 'secret'
      | 'config'
    )[];
  };
  /** Abort the stream. The async iterator returns on abort. */
  signal?: AbortSignal;
}

export class DockerEngineClient {
  private readonly socketPath: string;
  private readonly requestTimeout: number;

  constructor(options: DockerEngineClientOptions = {}) {
    const dockerHost = options.dockerHost ?? process.env['DOCKER_HOST'] ?? DEFAULT_DOCKER_HOST;
    if (!dockerHost.startsWith('unix://')) {
      throw new Error(
        `DOCKER_HOST must use unix:// scheme (got "${dockerHost}"); TCP not supported by this client`,
      );
    }
    this.socketPath = dockerHost.slice('unix://'.length);
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  }

  async listContainers(opts: ListContainersOptions = {}): Promise<ContainerSummary[]> {
    const query: Record<string, string> = {};
    if (opts.all) query['all'] = 'true';
    if (opts.filters) {
      // Docker expects filters as a URL-encoded JSON object of label→value-array maps.
      const labelFilters: string[] = [];
      const otherFilters: Record<string, string[]> = {};
      for (const [key, values] of Object.entries(opts.filters)) {
        if (key === 'label') {
          labelFilters.push(...values);
        } else {
          otherFilters[key] = values;
        }
      }
      const filterObj: Record<string, string[]> = { ...otherFilters };
      if (labelFilters.length > 0) filterObj['label'] = labelFilters;
      query['filters'] = JSON.stringify(filterObj);
    }
    const path = `/containers/json${this.buildQueryString(query)}`;
    const res = await this.request('GET', path);
    this.assertOk(res, path);
    return JSON.parse(res.body) as ContainerSummary[];
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const path = `/containers/${encodeURIComponent(id)}/json`;
    const res = await this.request('GET', path);
    this.assertOk(res, path);
    return JSON.parse(res.body) as ContainerInspect;
  }

  async createContainer(name: string, config: ContainerCreateBody): Promise<CreateContainerResponse> {
    const path = `/containers/create?name=${encodeURIComponent(name)}`;
    const res = await this.request('POST', path, JSON.stringify(config));
    this.assertOk(res, path, 201);
    return JSON.parse(res.body) as CreateContainerResponse;
  }

  async startContainer(id: string): Promise<void> {
    const path = `/containers/${encodeURIComponent(id)}/start`;
    const res = await this.request('POST', path);
    this.assertOk(res, path, 204);
  }

  async stopContainer(id: string): Promise<void> {
    const path = `/containers/${encodeURIComponent(id)}/stop`;
    const res = await this.request('POST', path);
    // Engine returns 204 on stop, 304 if already stopped (both fine).
    if (res.statusCode === 204 || res.statusCode === 304) return;
    this.assertOk(res, path, 204);
  }

  async removeContainer(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const query = opts.force ? '?force=true' : '';
    const path = `/containers/${encodeURIComponent(id)}${query}`;
    const res = await this.request('DELETE', path);
    this.assertOk(res, path, 204);
  }

  async connectNetwork(networkId: string, body: NetworkConnectBody): Promise<void> {
    const path = `/networks/${encodeURIComponent(networkId)}/connect`;
    const res = await this.request('POST', path, JSON.stringify(body));
    this.assertOk(res, path);
  }

  /**
   * Subscribe to the Docker Engine `/events` stream.
   *
   * Returns an async iterable that yields one `EngineEvent` per newline-delimited
   * JSON line from the daemon. The stream is long-lived; consumers should
   * implement their own reconnect/backoff. The iterator returns when:
   * - the daemon closes the stream (e.g. its own restart),
   * - the consumer breaks out of the `for await` loop, or
   * - `opts.signal` aborts.
   *
   * Throws `DockerDaemonUnavailableError` if the initial socket connection is
   * refused or the socket file is missing.
   */
  streamContainerEvents(opts: StreamContainerEventsOptions): AsyncIterable<EngineEvent> {
    const socketPath = this.socketPath;
    const filtersParam = encodeURIComponent(JSON.stringify(opts.filters));
    const path = `/events?filters=${filtersParam}`;
    const signal = opts.signal;

    return {
      [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        let res: IncomingMessage | null = null;
        let buffer = '';
        let ended = false;
        const eventQueue: EngineEvent[] = [];
        let pendingResolve: ((result: IteratorResult<EngineEvent>) => void) | null = null;
        let pendingReject: ((err: unknown) => void) | null = null;
        let initError: unknown = null;
        let connected = false;

        const settle = (): void => {
          if (!pendingResolve && !pendingReject) return;
          if (initError && !connected) {
            const reject = pendingReject;
            pendingResolve = null;
            pendingReject = null;
            reject?.(initError);
            return;
          }
          if (eventQueue.length > 0) {
            const value = eventQueue.shift()!;
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingReject = null;
            resolve?.({ value, done: false });
            return;
          }
          if (ended) {
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingReject = null;
            resolve?.({ value: undefined, done: true });
          }
        };

        const handleLine = (line: string): void => {
          const trimmed = line.trim();
          if (trimmed.length === 0) return;
          try {
            const parsed = JSON.parse(trimmed) as EngineEvent;
            eventQueue.push(parsed);
          } catch (err) {
            console.warn(
              `[docker-engine-client] skipping malformed /events line: ${trimmed.slice(0, 200)} (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        };

        const req = http.request(
          {
            socketPath,
            path,
            method: 'GET',
            headers: { Host: 'docker' },
          },
          (response) => {
            res = response;
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              // Consume body for the error message, then signal initError.
              let body = '';
              response.on('data', (chunk: Buffer) => {
                body += chunk.toString();
              });
              response.on('end', () => {
                initError = new DockerEngineError(statusCode, path, body || '<no body>');
                settle();
              });
              return;
            }
            connected = true;
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              buffer += chunk;
              let idx = buffer.indexOf('\n');
              while (idx !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                handleLine(line);
                idx = buffer.indexOf('\n');
              }
              settle();
            });
            response.on('end', () => {
              if (buffer.length > 0) {
                handleLine(buffer);
                buffer = '';
              }
              ended = true;
              settle();
            });
            response.on('error', (err) => {
              if (!ended) {
                initError = err;
                ended = true;
                settle();
              }
            });
          },
        );

        req.on('error', (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          if (!connected) {
            if (code === 'ECONNREFUSED' || code === 'ENOENT') {
              initError = new DockerDaemonUnavailableError(socketPath, err);
            } else {
              initError = err;
            }
          }
          ended = true;
          settle();
        });

        const abortHandler = (): void => {
          ended = true;
          try {
            req.destroy();
          } catch {
            // ignore
          }
          if (res) {
            try {
              res.destroy();
            } catch {
              // ignore
            }
          }
          settle();
        };

        if (signal) {
          if (signal.aborted) {
            abortHandler();
          } else {
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }

        req.end();

        return {
          next(): Promise<IteratorResult<EngineEvent>> {
            return new Promise<IteratorResult<EngineEvent>>((resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;
              settle();
            });
          },
          return(): Promise<IteratorResult<EngineEvent>> {
            ended = true;
            try {
              req.destroy();
            } catch {
              // ignore
            }
            if (res) {
              try {
                res.destroy();
              } catch {
                // ignore
              }
            }
            if (signal) {
              signal.removeEventListener('abort', abortHandler);
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  private buildQueryString(query: Record<string, string>): string {
    const entries = Object.entries(query);
    if (entries.length === 0) return '';
    return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  private assertOk(
    res: { statusCode: number; body: string },
    endpoint: string,
    expected: number = 200,
  ): void {
    if (res.statusCode === expected) return;
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    let engineMessage = res.body;
    try {
      const parsed = JSON.parse(res.body) as { message?: string };
      if (parsed.message) engineMessage = parsed.message;
    } catch {
      // Body wasn't JSON — keep raw text.
    }
    throw new DockerEngineError(res.statusCode, endpoint, engineMessage);
  }

  private request(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            ...(body !== undefined && {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 500, body: data });
          });
        },
      );

      req.setTimeout(this.requestTimeout, () => {
        req.destroy(new Error('Docker Engine API request timeout'));
      });

      req.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          reject(new DockerDaemonUnavailableError(this.socketPath, err));
          return;
        }
        reject(err);
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}
