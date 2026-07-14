import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema, DEFAULT_PROVIDER, resolveAgentForPhase } from '../config.js';
import type { WorkerConfig } from '../config.js';

/**
 * Precedence chain coverage per spec plan.md Acceptance Gate #1 / data-model.md §6:
 *
 *   1. agents.workflows.<name>.phases.<phase>
 *   2. agents.workflows.<name>.default
 *   3. agents.default
 *   4. defaultsAgent (provider-only)
 *   5. built-in DEFAULT_PROVIDER = 'claude-code' (provider-only)
 *
 * Provider and model walk INDEPENDENTLY over tiers 1-3 (Q3→A).
 */

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({ ...overrides });
}

describe('resolveAgentForPhase', () => {
  it('(a) phases.<phase> wins over workflows.<name>.default wins over agents.default', () => {
    const config = makeConfig({
      agents: {
        default: { provider: 'agents-default-provider', model: 'agents-default-model' },
        workflows: {
          'speckit-feature': {
            default: { provider: 'workflow-default-provider', model: 'workflow-default-model' },
            phases: {
              implement: { provider: 'phase-provider', model: 'phase-model' },
            },
          },
        },
      },
    });

    // Phase override wins for both fields
    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'phase-provider',
      model: 'phase-model',
    });

    // No phase override for `plan` — falls through to workflow default
    expect(resolveAgentForPhase(config, 'speckit-feature', 'plan')).toEqual({
      provider: 'workflow-default-provider',
      model: 'workflow-default-model',
    });

    // Unknown workflow — falls through to agents.default
    expect(resolveAgentForPhase(config, 'unknown-workflow', 'implement')).toEqual({
      provider: 'agents-default-provider',
      model: 'agents-default-model',
    });
  });

  it('(b) independent provider/model walks — phase override sets only model, provider resolves from a lower tier', () => {
    const config = makeConfig({
      agents: {
        default: { provider: 'agents-default-provider' },
        workflows: {
          'speckit-feature': {
            default: { provider: 'workflow-default-provider' },
            phases: {
              implement: { model: 'phase-only-model' }, // provider intentionally omitted
            },
          },
        },
      },
    });

    // provider comes from workflow default (skipping phase which has no provider)
    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'workflow-default-provider',
      model: 'phase-only-model',
    });
  });

  it('(b-bis) phase override sets only provider, model resolves from a lower tier', () => {
    const config = makeConfig({
      agents: {
        default: { model: 'agents-default-model' },
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'phase-only-provider' }, // model intentionally omitted
            },
          },
        },
      },
    });

    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'phase-only-provider',
      model: 'agents-default-model',
    });
  });

  it('(c) defaultsAgent supplies provider when no agents.* tier does', () => {
    const config = makeConfig({
      defaultsAgent: 'repo-defaults-agent',
    });

    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'repo-defaults-agent',
    });
  });

  it('(c-bis) agents.default.provider wins over defaultsAgent', () => {
    const config = makeConfig({
      defaultsAgent: 'repo-defaults-agent',
      agents: {
        default: { provider: 'agents-default-provider' },
      },
    });

    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'agents-default-provider',
    });
  });

  it('(d) env-tier folding: cluster env → config.worker.agents.default (loader-injected)', () => {
    // Simulate what the loader writes when WORKER_AGENT_PROVIDER/WORKER_AGENT_MODEL
    // are set: values land in config.agents.default. The resolver treats this
    // identically to a config-file-provided agents.default entry.
    const config = makeConfig({
      agents: {
        default: { provider: 'env-provider', model: 'env-model' },
      },
    });

    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: 'env-provider',
      model: 'env-model',
    });

    // A workflow-tier override still wins over the env tier.
    const configWithOverride = makeConfig({
      agents: {
        default: { provider: 'env-provider', model: 'env-model' },
        workflows: {
          'speckit-feature': {
            phases: { plan: { model: 'plan-model' } },
          },
        },
      },
    });

    expect(resolveAgentForPhase(configWithOverride, 'speckit-feature', 'plan')).toEqual({
      provider: 'env-provider', // no phase override for provider — falls back
      model: 'plan-model',
    });
  });

  it('(e) built-in claude-code fallback when nothing is configured', () => {
    const config = makeConfig({});

    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement')).toEqual({
      provider: DEFAULT_PROVIDER,
    });
    expect(DEFAULT_PROVIDER).toBe('claude-code');
  });

  it('(f) model returns undefined when no tier sets it', () => {
    const config = makeConfig({
      agents: {
        default: { provider: 'some-provider' },
      },
    });

    const result = resolveAgentForPhase(config, 'speckit-feature', 'implement');
    expect(result.provider).toBe('some-provider');
    expect(result.model).toBeUndefined();
  });

  it('resolves independently per phase — different phases produce different results', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { model: 'sonnet' },
              implement: { model: 'opus' },
            },
          },
        },
      },
    });

    expect(resolveAgentForPhase(config, 'speckit-feature', 'plan').model).toBe('sonnet');
    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement').model).toBe('opus');
    // Provider falls back to built-in for both.
    expect(resolveAgentForPhase(config, 'speckit-feature', 'plan').provider).toBe(DEFAULT_PROVIDER);
    expect(resolveAgentForPhase(config, 'speckit-feature', 'implement').provider).toBe(DEFAULT_PROVIDER);
  });
});
