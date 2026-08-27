/**
 * SC-001 / SC-004: `collectGatewayWarnings` emits a warning naming the exact
 * config path and model when an entry explicitly sets a gateway-routed model
 * while `GENERACY_LLM_GATEWAY_URL` is unset.
 *
 * `resolveRoute` from the claude-code plugin is mocked so route classification
 * is deterministic and independent of the shipped plugin. Env is injected via
 * the second `collectGatewayWarnings` parameter — `process.env` is never mutated.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the plugin's resolveRoute BEFORE importing the loader (vi.mock hoists).
vi.mock('@generacy-ai/generacy-plugin-claude-code', () => ({
  resolveRoute: (model?: string) =>
    typeof model === 'string' && model.includes('/') ? 'gateway' : 'subscription',
}));

import { collectGatewayWarnings } from '../loader.js';
import type { GeneracyConfig } from '../schema.js';

const GATEWAY_MODEL = 'my-org/gpt-4o';
const SUBSCRIPTION_MODEL = 'opus-4-7';

function baseConfig(overrides: Partial<GeneracyConfig> = {}): GeneracyConfig {
  return {
    schemaVersion: '1',
    project: { id: 'proj_gateway123', name: 'Gateway Test' },
    repos: { primary: 'github.com/test/repo', dev: [], clone: [] },
    ...overrides,
  } as GeneracyConfig;
}

const NO_URL_ENV: NodeJS.ProcessEnv = {};
const WITH_URL_ENV: NodeJS.ProcessEnv = { GENERACY_LLM_GATEWAY_URL: 'https://gw.example' };

describe('collectGatewayWarnings — SC-001 / SC-004 (issue #1200)', () => {
  it('warns for a gateway-routed orchestrator.agents.default when URL unset', () => {
    const config = baseConfig({
      orchestrator: { agents: { default: { model: GATEWAY_MODEL } } },
    } as Partial<GeneracyConfig>);

    const warnings = collectGatewayWarnings(config, NO_URL_ENV);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('orchestrator.agents.default.model');
    expect(warnings[0]).toContain(GATEWAY_MODEL);
    expect(warnings[0]).toContain('GENERACY_LLM_GATEWAY_URL is not set');
  });

  it('stays silent when the gateway URL is set', () => {
    const config = baseConfig({
      orchestrator: { agents: { default: { model: GATEWAY_MODEL } } },
    } as Partial<GeneracyConfig>);

    expect(collectGatewayWarnings(config, WITH_URL_ENV)).toEqual([]);
  });

  it('stays silent for a subscription-route model regardless of env', () => {
    const config = baseConfig({
      orchestrator: { agents: { default: { model: SUBSCRIPTION_MODEL } } },
    } as Partial<GeneracyConfig>);

    expect(collectGatewayWarnings(config, NO_URL_ENV)).toEqual([]);
    expect(collectGatewayWarnings(config, WITH_URL_ENV)).toEqual([]);
  });

  it('warns at the workflow-default tier with the exact path', () => {
    const config = baseConfig({
      orchestrator: {
        agents: {
          workflows: {
            'speckit-feature': { default: { model: GATEWAY_MODEL } },
          },
        },
      },
    } as Partial<GeneracyConfig>);

    const warnings = collectGatewayWarnings(config, NO_URL_ENV);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'orchestrator.agents.workflows.speckit-feature.default.model',
    );
  });

  it('warns at the phase tier with the exact path', () => {
    const config = baseConfig({
      orchestrator: {
        agents: {
          workflows: {
            'speckit-feature': {
              phases: { implement: { model: GATEWAY_MODEL } },
            },
          },
        },
      },
    } as Partial<GeneracyConfig>);

    const warnings = collectGatewayWarnings(config, NO_URL_ENV);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'orchestrator.agents.workflows.speckit-feature.phases.implement.model',
    );
  });

  it('warns at cockpit.auto.agents.default and role tiers via the duck-walk', () => {
    const config = baseConfig({
      cockpit: {
        auto: {
          agents: {
            default: { model: GATEWAY_MODEL },
            fixer: { model: GATEWAY_MODEL },
          },
        },
      },
    } as Partial<GeneracyConfig>);

    const warnings = collectGatewayWarnings(config, NO_URL_ENV);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('cockpit.auto.agents.default.model'))).toBe(true);
    expect(warnings.some((w) => w.includes('cockpit.auto.agents.fixer.model'))).toBe(true);
  });

  it('does not crash and emits nothing on a malformed cockpit block', () => {
    const config = baseConfig({
      cockpit: { auto: 'not-an-object' },
    } as Partial<GeneracyConfig>);

    expect(() => collectGatewayWarnings(config, NO_URL_ENV)).not.toThrow();
    expect(collectGatewayWarnings(config, NO_URL_ENV)).toEqual([]);
  });

  it('does not crash and emits nothing on an absent cockpit block', () => {
    expect(collectGatewayWarnings(baseConfig(), NO_URL_ENV)).toEqual([]);
  });

  it('ignores entries that do not explicitly set a model', () => {
    const config = baseConfig({
      orchestrator: { agents: { default: { effort: 'high' } } },
    } as Partial<GeneracyConfig>);

    expect(collectGatewayWarnings(config, NO_URL_ENV)).toEqual([]);
  });
});
