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

export const stripeRestrictedKeyPlugin: CredentialTypePlugin = {
  type: 'stripe-restricted-key',
  credentialSchema,
  supportedExposures: ['env'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    const key = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: key, format: 'key' };
  },

  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): PluginExposureData {
    if (kind === 'env') {
      return {
        kind: 'env',
        entries: [{ key: cfg.kind === 'env' ? cfg.name : 'STRIPE_API_KEY', value: secret.value }],
      };
    }
    throw new Error(`Unsupported exposure kind: ${kind}`);
  },
};
