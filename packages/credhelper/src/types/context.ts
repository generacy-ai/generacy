export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

export interface WritableBackendClient extends BackendClient {
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;
  ttl: number;
  config: Record<string, unknown>;
}

export interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  config: Record<string, unknown>;
}
