export type ExposureKind =
  | 'env'
  | 'git-credential-helper'
  | 'gcloud-external-account'
  | 'localhost-proxy'
  | 'docker-socket-proxy'
  | 'file';

export type ExposureConfig =
  | { kind: 'env'; name: string }
  | { kind: 'git-credential-helper' }
  | { kind: 'gcloud-external-account' }
  | { kind: 'localhost-proxy'; port: number }
  | { kind: 'docker-socket-proxy' }
  | { kind: 'file'; path: string; mode?: number };

export type ExposureOutput =
  | { kind: 'env'; entries: Array<{ key: string; value: string }> }
  | { kind: 'git-credential-helper'; script: string }
  | { kind: 'gcloud-external-account'; json: object }
  | { kind: 'localhost-proxy'; proxyConfig: { port: number; upstream: string; headers: Record<string, string> } }
  | { kind: 'docker-socket-proxy'; socketPath: string }
  | { kind: 'file'; data: string; path: string; mode: number };
