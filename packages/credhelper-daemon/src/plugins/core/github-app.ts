import * as crypto from 'node:crypto';
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
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
});

const scopeSchema = z.object({
  repositories: z.array(z.string()).optional(),
  permissions: z.record(z.string()).optional(),
});

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function createGitHubAppJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: appId,
    iat: now - 60,
    exp: now + 600,
  };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ];

  const signingInput = segments.join('.');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = base64url(sign.sign(privateKey));

  return `${signingInput}.${signature}`;
}

export const githubAppPlugin: CredentialTypePlugin = {
  type: 'github-app',
  credentialSchema,
  scopeSchema,
  supportedExposures: ['env', 'git-credential-helper'],

  async mint(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }> {
    const privateKey = await ctx.backend.fetchSecret(ctx.backendKey);
    const { appId, installationId } = credentialSchema.parse(ctx.config);

    const jwt = createGitHubAppJwt(appId, privateKey);

    const body: Record<string, unknown> = {};
    const scope = ctx.scope as { repositories?: string[]; permissions?: Record<string, string> };
    if (scope.repositories) {
      body.repositories = scope.repositories;
    }
    if (scope.permissions) {
      body.permissions = scope.permissions;
    }

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API error (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as { token: string; expires_at: string };

    return {
      value: { value: data.token, format: 'token' },
      expiresAt: new Date(data.expires_at),
    };
  },

  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): PluginExposureData {
    if (kind === 'env') {
      const name = cfg.kind === 'env' ? cfg.name : 'GITHUB_TOKEN';
      return { kind: 'env', entries: [{ key: name, value: secret.value }] };
    }
    if (kind === 'git-credential-helper') {
      return {
        kind: 'git-credential-helper',
        host: 'github.com',
        protocol: 'https',
        username: 'x-access-token',
        password: secret.value,
      };
    }
    throw new Error(`Unsupported exposure kind: ${kind}`);
  },
};
