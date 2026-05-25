// Docker Engine API DTOs and error classes.
//
// PascalCase matches the Docker daemon's wire format directly — used as-is in
// TypeScript types rather than translating to camelCase (saves a layer).
//
// Type definitions cover only the fields we read; full responses arrive as
// `unknown` from node:http and are narrowed at the boundary.
//
// Stable across Docker Engine API v1.41+ (matches apt-installed docker on
// Ubuntu 22+ and the daemon mounted via DooD in cluster-base).

export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'restarting'
  | 'dead'
  | 'created';

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: ContainerState;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID: string }>;
  };
}

export interface NetworkEndpoint {
  NetworkID: string;
  Aliases?: string[];
  IPAddress?: string;
  IPPrefixLen?: number;
  IPAMConfig?: { IPv4Address?: string };
}

export interface HealthConfig {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

export interface Mount {
  Type: 'bind' | 'volume' | 'tmpfs';
  Source?: string;
  Target: string;
  ReadOnly?: boolean;
  BindOptions?: { Propagation?: string };
  VolumeOptions?: { NoCopy?: boolean; Labels?: Record<string, string> };
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    Hostname?: string;
    Domainname?: string;
    User?: string;
    Env?: string[];
    Cmd?: string[];
    Entrypoint?: string[] | string;
    Labels?: Record<string, string>;
    WorkingDir?: string;
    Healthcheck?: HealthConfig;
    StopSignal?: string;
    StopTimeout?: number;
    ExposedPorts?: Record<string, Record<string, never>>;
  };
  HostConfig: {
    Binds?: string[];
    Mounts?: Mount[];
    NetworkMode?: string;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    LogConfig?: { Type: string; Config: Record<string, string> };
    Resources?: {
      Memory?: number;
      MemorySwap?: number;
      CpuShares?: number;
      CpusetCpus?: string;
    };
    SecurityOpt?: string[];
    CapAdd?: string[];
    CapDrop?: string[];
    Devices?: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[];
    Init?: boolean;
    IpcMode?: string;
    PidMode?: string;
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
  };
  NetworkSettings: {
    Networks: Record<string, NetworkEndpoint>;
  };
}

export interface NetworkEndpointCreate {
  Aliases?: string[];
  IPAMConfig?: { IPv4Address?: string };
}

export interface ContainerCreateBody {
  Hostname?: string;
  User?: string;
  Env?: string[];
  Cmd?: string[];
  Entrypoint?: string[] | string;
  Image: string;
  Labels?: Record<string, string>;
  WorkingDir?: string;
  Healthcheck?: HealthConfig;
  StopSignal?: string;
  StopTimeout?: number;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: ContainerInspect['HostConfig'];
  NetworkingConfig: {
    EndpointsConfig: Record<string, NetworkEndpointCreate>;
  };
}

export interface NetworkConnectBody {
  Container: string;
  EndpointConfig?: NetworkEndpointCreate;
}

/**
 * Narrowed shape of a Docker Engine `/events` line. Only the fields we read.
 * Stable across Engine API v1.41+.
 */
export interface EngineEvent {
  Type: 'container';
  Action: string;
  id?: string;
  Actor?: {
    ID?: string;
    Attributes?: Record<string, string>;
  };
  time?: number;
  timeNano?: number;
}

export class DockerEngineError extends Error {
  override readonly name = 'DockerEngineError';
  readonly statusCode: number;
  readonly endpoint: string;
  readonly engineMessage: string;

  constructor(statusCode: number, endpoint: string, engineMessage: string) {
    super(`Docker Engine API ${endpoint} returned ${statusCode}: ${engineMessage}`);
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.engineMessage = engineMessage;
  }
}

export class DockerDaemonUnavailableError extends Error {
  override readonly name = 'DockerDaemonUnavailableError';
  readonly socketPath: string;
  override readonly cause?: Error;

  constructor(socketPath: string, cause?: Error) {
    // Message is 'DOCKER_DAEMON_UNAVAILABLE' so existing string-match code paths
    // in lifecycle.ts can continue to discriminate by message before the route
    // handler migrates to instanceof checks.
    super('DOCKER_DAEMON_UNAVAILABLE');
    this.socketPath = socketPath;
    if (cause) this.cause = cause;
  }
}
