import { describe, it, expect } from 'vitest';
import type { OrchestratorSettings } from '@generacy-ai/config';
import {
  WorkerConfigSchema,
  resolveWorkflowOverrides,
  DEFAULT_REVIEW,
  type WorkerConfig,
} from '../config.js';

const CLUSTER_VALIDATE = 'pnpm test && pnpm build';

function makeConfig(): WorkerConfig {
  return WorkerConfigSchema.parse({});
}

describe('resolveWorkflowOverrides (issue #1122)', () => {
  it('SC-001: settings=null → cluster defaults + built-in maxRemediations + DEFAULT_REVIEW', () => {
    const config = makeConfig();
    const feature = resolveWorkflowOverrides(config, null, 'speckit-feature');
    expect(feature.validateCommand).toBe(config.validateCommand);
    expect(feature.validateCommand).toBe(CLUSTER_VALIDATE);
    expect(feature.preValidateCommand).toBe(config.preValidateCommand);
    expect(feature.maxRemediations).toBe(3);
    // speckit-feature is held to the stricter `major` blocking bar (#1161 D3).
    expect(feature.review).toEqual({ ...DEFAULT_REVIEW, blockingSeverity: 'major' });

    const bugfix = resolveWorkflowOverrides(config, undefined, 'speckit-bugfix');
    expect(bugfix.maxRemediations).toBe(2);
    expect(bugfix.review).toEqual({ ...DEFAULT_REVIEW, blockingSeverity: 'critical' });

    // No workflows block present on settings behaves identically.
    const settings: OrchestratorSettings = { validateCommand: undefined };
    const noWorkflows = resolveWorkflowOverrides(config, settings, 'speckit-feature');
    expect(noWorkflows.validateCommand).toBe(CLUSTER_VALIDATE);
    expect(noWorkflows.maxRemediations).toBe(3);
    expect(noWorkflows.review).toEqual({ ...DEFAULT_REVIEW, blockingSeverity: 'major' });
  });

  it('SC-002: repo-level validateCommand (no workflow entry) wins over cluster default', () => {
    const config = makeConfig();
    const settings: OrchestratorSettings = {
      validateCommand: 'pnpm build',
      preValidateCommand: 'npm ci',
    };
    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-feature');
    expect(resolved.validateCommand).toBe('pnpm build');
    expect(resolved.preValidateCommand).toBe('npm ci');
    // maxRemediations / review have no repo tier → built-in defaults (Q2).
    expect(resolved.maxRemediations).toBe(3);
    expect(resolved.review).toEqual({ ...DEFAULT_REVIEW, blockingSeverity: 'major' });
  });

  it('SC-003: workflow-level wins over repo + cluster; partial review inherits; "" and 0 preserved', () => {
    const config = makeConfig();
    const settings: OrchestratorSettings = {
      validateCommand: 'pnpm build', // repo tier — should be overridden
      preValidateCommand: 'npm ci',
      workflows: {
        'speckit-bugfix': {
          validateCommand: 'pnpm lint',
          preValidateCommand: '', // explicit skip — must be preserved
          maxRemediations: 0, // explicit zero — must be preserved
          review: { blockingSeverity: 'minor' }, // partial — inherits profile/failThenPass
        },
      },
    };
    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');
    expect(resolved.validateCommand).toBe('pnpm lint');
    expect(resolved.preValidateCommand).toBe('');
    expect(resolved.maxRemediations).toBe(0);
    expect(resolved.review.blockingSeverity).toBe('minor');
    expect(resolved.review.profile).toBe(DEFAULT_REVIEW.profile);
    expect(resolved.review.failThenPass).toBe(DEFAULT_REVIEW.failThenPass);
  });

  it('SC-005: no workflows block → validate/prevalidate identical to today; inputs not mutated', () => {
    const config = makeConfig();
    const settings: OrchestratorSettings = {
      validateCommand: 'pnpm build',
      preValidateCommand: '',
    };
    const configSnapshot = JSON.stringify(config);
    const settingsSnapshot = JSON.stringify(settings);

    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-feature');
    expect(resolved.validateCommand).toBe('pnpm build');
    expect(resolved.preValidateCommand).toBe('');

    // Resolver is pure — neither input mutated.
    expect(JSON.stringify(config)).toBe(configSnapshot);
    expect(JSON.stringify(settings)).toBe(settingsSnapshot);
  });

  it('unknown workflow name falls back to maxRemediations=3', () => {
    const config = makeConfig();
    const resolved = resolveWorkflowOverrides(config, null, 'speckit-epic');
    expect(resolved.maxRemediations).toBe(3);
  });

  describe('ciWaitTimeoutMs precedence (issue #1160, FR-006)', () => {
    it('settings=null → cluster base ciWaitTimeoutMs', () => {
      const config = makeConfig();
      const resolved = resolveWorkflowOverrides(config, null, 'speckit-feature');
      expect(resolved.ciWaitTimeoutMs).toBe(config.ciWaitTimeoutMs);
      expect(resolved.ciWaitTimeoutMs).toBe(900_000);
    });

    it('workflow-level override wins over cluster base', () => {
      const config = makeConfig();
      const settings: OrchestratorSettings = {
        workflows: {
          'speckit-feature': { ciWaitTimeoutMs: 1_800_000 },
        },
      };
      const feature = resolveWorkflowOverrides(config, settings, 'speckit-feature');
      expect(feature.ciWaitTimeoutMs).toBe(1_800_000);

      // A workflow without its own override falls through to the cluster base.
      const bugfix = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');
      expect(bugfix.ciWaitTimeoutMs).toBe(config.ciWaitTimeoutMs);
    });

    it('no repo tier — settings.workflows absent → cluster base', () => {
      const config = makeConfig();
      const settings: OrchestratorSettings = { validateCommand: 'pnpm build' };
      const resolved = resolveWorkflowOverrides(config, settings, 'speckit-feature');
      expect(resolved.ciWaitTimeoutMs).toBe(config.ciWaitTimeoutMs);
    });
  });
});
