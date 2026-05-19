import { describe, it, expect } from 'vitest';
import type { ActivationResult } from '../../../src/activation/types.js';

/**
 * Tests the boot-time URL override logic from server.ts (T009).
 *
 * We can't import createServer directly (missing transitive deps in test env),
 * so we extract and test the URL derivation logic that server.ts uses.
 */

/** Replicates the config override logic from server.ts lines 315-322 */
function applyActivationOverride(
  config: { activation: { cloudUrl: string }; relay: { cloudUrl: string; apiKey?: string; clusterApiKeyId?: string } },
  result: ActivationResult,
) {
  config.relay.apiKey = result.apiKey;
  config.relay.clusterApiKeyId = result.clusterApiKeyId;
  if (result.cloudUrl) {
    config.activation.cloudUrl = result.cloudUrl;
    const relayUrl = result.cloudUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/relay';
    config.relay.cloudUrl = relayUrl;
  }
}

describe('boot-time cloudUrl override (T009)', () => {
  it('overrides config.activation.cloudUrl and config.relay.cloudUrl from activation result', () => {
    const config = {
      activation: { cloudUrl: 'https://api.generacy.ai' },
      relay: { cloudUrl: 'wss://api.generacy.ai/relay' },
    };

    applyActivationOverride(config, {
      apiKey: 'test-key',
      clusterApiKeyId: 'kid-test',
      clusterId: 'cl-test',
      projectId: 'pj-test',
      orgId: 'org-test',
      cloudUrl: 'https://custom.generacy.example.com',
    });

    expect(config.activation.cloudUrl).toBe('https://custom.generacy.example.com');
    expect(config.relay.cloudUrl).toBe('wss://custom.generacy.example.com/relay');
    expect(config.relay.apiKey).toBe('test-key');
  });

  it('does not override config when cloudUrl is absent', () => {
    const config = {
      activation: { cloudUrl: 'https://api.generacy.ai' },
      relay: { cloudUrl: 'wss://api.generacy.ai/relay' },
    };

    applyActivationOverride(config, {
      apiKey: 'test-key',
      clusterApiKeyId: 'kid-test',
      clusterId: 'cl-test',
      projectId: 'pj-test',
      orgId: 'org-test',
    });

    expect(config.activation.cloudUrl).toBe('https://api.generacy.ai');
    expect(config.relay.cloudUrl).toBe('wss://api.generacy.ai/relay');
  });

  it('derives ws:// relay URL from http:// cloud URL', () => {
    const config = {
      activation: { cloudUrl: 'https://api.generacy.ai' },
      relay: { cloudUrl: 'wss://api.generacy.ai/relay' },
    };

    applyActivationOverride(config, {
      apiKey: 'test-key',
      clusterApiKeyId: 'kid-test',
      clusterId: 'cl-test',
      projectId: 'pj-test',
      orgId: 'org-test',
      cloudUrl: 'http://localhost:3000',
    });

    expect(config.activation.cloudUrl).toBe('http://localhost:3000');
    expect(config.relay.cloudUrl).toBe('ws://localhost:3000/relay');
  });

  it('strips trailing slash before appending /relay', () => {
    const config = {
      activation: { cloudUrl: 'https://api.generacy.ai' },
      relay: { cloudUrl: 'wss://api.generacy.ai/relay' },
    };

    applyActivationOverride(config, {
      apiKey: 'test-key',
      clusterId: 'cl-test',
      projectId: 'pj-test',
      orgId: 'org-test',
      cloudUrl: 'https://custom.example.com/',
    });

    expect(config.relay.cloudUrl).toBe('wss://custom.example.com/relay');
  });
});
