export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
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
