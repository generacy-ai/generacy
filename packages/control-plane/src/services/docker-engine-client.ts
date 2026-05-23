import http from 'node:http';
import {
  type ContainerSummary,
  type ContainerInspect,
  type ContainerCreateBody,
  type NetworkConnectBody,
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
