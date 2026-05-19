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

export const githubPatPlugin: CredentialTypePlugin = {
  type: 'github-pat',
  credentialSchema,
  supportedExposures: ['env', 'git-credential-helper'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    const token = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: token, format: 'token' };
  },

  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): PluginExposureData {
    switch (kind) {
      case 'env':
        return {
          kind: 'env',
          entries: [{ key: cfg.kind === 'env' ? cfg.name : 'GITHUB_TOKEN', value: secret.value }],
        };
      case 'git-credential-helper':
        return {
          kind: 'git-credential-helper',
          host: 'github.com',
          protocol: 'https',
          username: 'x-access-token',
          password: secret.value,
        };
      default:
        throw new Error(`Unsupported exposure kind: ${kind}`);
    }
  },
};
