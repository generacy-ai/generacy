import { z } from 'zod';
import type {
  CredentialTypePlugin,
  ExposureKind,
  Secret,
  ExposureConfig,
  PluginExposureData,
  ResolveContext,
} from '@generacy-ai/credhelper';

const credentialSchema = z.object({}).passthrough();

export const envPassthroughPlugin: CredentialTypePlugin = {
  type: 'env-passthrough',
  credentialSchema,
  supportedExposures: ['env'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    const value = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value, format: 'opaque' };
  },

  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): PluginExposureData {
    if (kind === 'env') {
      return {
        kind: 'env',
        entries: [{ key: cfg.kind === 'env' ? cfg.name : 'SECRET', value: secret.value }],
      };
    }
    throw new Error(`Unsupported exposure kind: ${kind}`);
  },
};
