export interface PluginEnvExposure {
  kind: 'env';
  entries: Array<{ key: string; value: string }>;
}

export interface PluginGitCredentialHelperExposure {
  kind: 'git-credential-helper';
  host: string;
  protocol: string;
  username: string;
  password: string;
}

export interface PluginGcloudExternalAccountExposure {
  kind: 'gcloud-external-account';
  audience: string;
  subjectTokenType: string;
  tokenUrl: string;
  serviceAccountImpersonationUrl?: string;
}

export interface PluginLocalhostProxyExposure {
  kind: 'localhost-proxy';
  upstream: string;
  headers: Record<string, string>;
}

export type PluginExposureData =
  | PluginEnvExposure
  | PluginGitCredentialHelperExposure
  | PluginGcloudExternalAccountExposure
  | PluginLocalhostProxyExposure;
