export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

export interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;
  ttl: number;
}

export interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
}
