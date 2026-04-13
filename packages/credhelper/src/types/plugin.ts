import type { ZodSchema } from 'zod';
import type { Secret } from './secret.js';
import type { ExposureKind, ExposureConfig, ExposureOutput } from './exposure.js';
import type { MintContext, ResolveContext } from './context.js';

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
  ): ExposureOutput;
}
