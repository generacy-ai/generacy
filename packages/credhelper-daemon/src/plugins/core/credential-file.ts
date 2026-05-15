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

export const credentialFilePlugin: CredentialTypePlugin = {
  type: 'credential-file',
  credentialSchema,
  supportedExposures: ['file'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    const blob = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: blob, format: 'blob' };
  },

  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): PluginExposureData {
    if (kind !== 'file') {
      throw new Error(`Unsupported exposure kind: ${kind}`);
    }
    if (cfg.kind !== 'file') {
      throw new Error(`Expected file exposure config, got: ${cfg.kind}`);
    }

    const decoded = Buffer.from(secret.value, 'base64');
    return {
      kind: 'file',
      data: decoded,
      path: cfg.path,
      mode: cfg.mode,
    };
  },
};
