export interface SshTarget {
  user: string;
  host: string;
  port: number;
  remotePath: string | null;
}

export interface DeployOptions {
  target: string;
  timeout?: number;
  cloudUrl?: string;
}

export interface DeployResult {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  managementEndpoint: string;
  remotePath: string;
}

export type DeployErrorCode =
  | 'INVALID_TARGET'
  | 'SSH_CONNECT_FAILED'
  | 'DOCKER_MISSING'
  | 'ACTIVATION_FAILED'
  | 'LAUNCH_CONFIG_FAILED'
  | 'SCP_FAILED'
  | 'COMPOSE_FAILED'
  | 'REGISTRATION_TIMEOUT'
  | 'PULL_FAILED';

export class DeployError extends Error {
  constructor(
    message: string,
    public readonly code: DeployErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DeployError';
  }
}
