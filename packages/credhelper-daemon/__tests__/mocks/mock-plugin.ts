import { z } from 'zod';
import type {
  CredentialTypePlugin,
  Secret,
  ExposureKind,
  ExposureConfig,
  ExposureOutput,
  MintContext,
  ResolveContext,
} from '@generacy-ai/credhelper';

export interface MockPluginOptions {
  type?: string;
  supportedExposures?: ExposureKind[];
  mintBehavior?: 'success' | 'failure' | 'delay';
  mintDelay?: number;
  mintValue?: Secret;
  mintTtlMs?: number;
  resolveValue?: Secret;
  resolveBehavior?: 'success' | 'failure';
}

export function createMockPlugin(
  options: MockPluginOptions = {},
): CredentialTypePlugin {
  const {
    type = 'mock',
    supportedExposures = ['env'],
    mintBehavior = 'success',
    mintDelay = 0,
    mintValue = { value: 'mock-secret-value' },
    mintTtlMs = 3600000,
    resolveValue = { value: 'mock-resolved-value' },
    resolveBehavior = 'success',
  } = options;

  return {
    type,
    credentialSchema: z.object({ id: z.string() }),
    supportedExposures,

    async mint(ctx: MintContext) {
      if (mintBehavior === 'failure') throw new Error('Mock mint failure');
      if (mintBehavior === 'delay')
        await new Promise((r) => setTimeout(r, mintDelay));
      return { value: mintValue, expiresAt: new Date(Date.now() + mintTtlMs) };
    },

    async resolve(ctx: ResolveContext) {
      if (resolveBehavior === 'failure')
        throw new Error('Mock resolve failure');
      return resolveValue;
    },

    renderExposure(
      kind: ExposureKind,
      secret: Secret,
      cfg: ExposureConfig,
    ): ExposureOutput {
      if (kind === 'env') {
        const name = cfg.kind === 'env' ? cfg.name : 'MOCK_SECRET';
        return { kind: 'env', entries: [{ key: name, value: secret.value }] };
      }
      if (kind === 'git-credential-helper') {
        return {
          kind: 'git-credential-helper',
          script: '#!/bin/sh\necho mock',
        };
      }
      if (kind === 'gcloud-external-account') {
        return {
          kind: 'gcloud-external-account',
          json: { type: 'external_account' },
        };
      }
      throw new Error(`Unsupported exposure: ${kind}`);
    },
  };
}
