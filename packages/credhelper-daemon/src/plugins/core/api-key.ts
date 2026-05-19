import { z } from 'zod';
import type {
  CredentialTypePlugin,
  ExposureKind,
  Secret,
  ExposureConfig,
  PluginExposureData,
  ResolveContext,
} from '@generacy-ai/credhelper';

const credentialSchema = z.object({
  upstream: z.string().url().optional(),
}).passthrough();

/**
 * Captured credential config from the most recent resolve() call.
 * renderExposure() needs access to `upstream` from the credential config,
 * but the CredentialTypePlugin interface only passes (kind, secret, cfg).
 * In the daemon flow, resolve() is always called before renderExposure()
 * for the same credential, so this module-level cache is safe.
 */
let lastResolvedConfig: Record<string, unknown> = {};

export const apiKeyPlugin: CredentialTypePlugin = {
  type: 'api-key',
  credentialSchema,
  supportedExposures: ['env', 'localhost-proxy'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    lastResolvedConfig = ctx.config;
    const key = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: key, format: 'key' };
  },

  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): PluginExposureData {
    switch (kind) {
      case 'env':
        return {
          kind: 'env',
          entries: [{ key: cfg.kind === 'env' ? cfg.name : 'API_KEY', value: secret.value }],
        };
      case 'localhost-proxy': {
        const upstream = (lastResolvedConfig.upstream as string) ?? '';
        return {
          kind: 'localhost-proxy',
          upstream,
          headers: { Authorization: `Bearer ${secret.value}` },
        };
      }
      default:
        throw new Error(`Unsupported exposure kind: ${kind}`);
    }
  },
};
