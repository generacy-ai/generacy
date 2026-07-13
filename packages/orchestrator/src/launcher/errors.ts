export class UnknownProviderError extends Error {
  readonly name = 'UnknownProviderError';
  readonly provider: string;
  readonly kind: string;
  readonly availableProviders: readonly string[];
  constructor(provider: string, kind: string, availableProviders: readonly string[]) {
    super(
      `Unknown provider "${provider}" for intent kind "${kind}". Available providers: ${availableProviders.join(', ') || '(none)'}`,
    );
    this.provider = provider;
    this.kind = kind;
    this.availableProviders = availableProviders;
  }
}

export class DuplicatePluginRegistrationError extends Error {
  readonly name = 'DuplicatePluginRegistrationError';
  readonly provider: string;
  readonly kind: string;
  readonly existingPluginId: string;
  constructor(provider: string, kind: string, existingPluginId: string) {
    super(
      `Intent (provider: "${provider}", kind: "${kind}") already registered by plugin "${existingPluginId}"`,
    );
    this.provider = provider;
    this.kind = kind;
    this.existingPluginId = existingPluginId;
  }
}
