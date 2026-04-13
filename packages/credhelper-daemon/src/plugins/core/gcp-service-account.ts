import { z } from 'zod';
import type {
  CredentialTypePlugin,
  ExposureKind,
  Secret,
  ExposureConfig,
  PluginExposureData,
  MintContext,
} from '@generacy-ai/credhelper';

const credentialSchema = z.object({
  serviceAccountEmail: z.string().email(),
  projectId: z.string().optional(),
});

const scopeSchema = z.object({
  scopes: z.array(z.string()).min(1),
});

export const gcpServiceAccountPlugin: CredentialTypePlugin = {
  type: 'gcp-service-account',
  credentialSchema,
  scopeSchema,
  supportedExposures: ['env', 'gcloud-external-account'],

  async mint(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }> {
    const baseToken = await ctx.backend.fetchSecret(ctx.backendKey);
    const { serviceAccountEmail } = credentialSchema.parse(ctx.config);
    const { scopes } = ctx.scope as { scopes: string[] };

    const lifetime = Math.min(Math.floor(ctx.ttl / 1000), 3600);
    const lifetimeStr = `${lifetime}s`;

    const response = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${baseToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scope: scopes, lifetime: lifetimeStr }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GCP IAM API error (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      accessToken: string;
      expireTime: string;
    };

    return {
      value: { value: data.accessToken, format: 'token' },
      expiresAt: new Date(data.expireTime),
    };
  },

  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): PluginExposureData {
    if (kind === 'env') {
      const name =
        cfg.kind === 'env' ? cfg.name : 'CLOUDSDK_AUTH_ACCESS_TOKEN';
      return { kind: 'env', entries: [{ key: name, value: secret.value }] };
    }
    if (kind === 'gcloud-external-account') {
      return {
        kind: 'gcloud-external-account',
        audience:
          '//iam.googleapis.com/projects/-/locations/global/workloadIdentityPools/credhelper/providers/daemon',
        subjectTokenType:
          'urn:ietf:params:oauth:token-type:access_token',
        tokenUrl: 'https://sts.googleapis.com/v1/token',
      };
    }
    throw new Error(`Unsupported exposure kind: ${kind}`);
  },
};
