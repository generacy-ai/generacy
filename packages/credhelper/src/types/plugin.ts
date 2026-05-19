import type { ZodSchema } from 'zod';
import type { Secret } from './secret.js';
import type { ExposureKind, ExposureConfig } from './exposure.js';
import type { MintContext, ResolveContext } from './context.js';
import type { PluginExposureData } from './plugin-exposure.js';

export interface CredentialTypePlugin {
  type: string;
  credentialSchema: ZodSchema;
  scopeSchema?: ZodSchema;
  supportedExposures: ExposureKind[];
  mint?(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }>;
  resolve?(ctx: ResolveContext): Promise<Secret>;
  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): PluginExposureData;
}
