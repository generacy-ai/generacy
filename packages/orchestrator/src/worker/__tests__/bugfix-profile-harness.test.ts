import { describe, it, expect } from 'vitest';
import type { OrchestratorSettings } from '@generacy-ai/config';
import {
  WorkerConfigSchema,
  resolveWorkflowOverrides,
  resolveAgentForPhase,
  DEFAULT_VALIDATE_COMMAND,
  type WorkerConfig,
} from '../config.js';
import { buildReviewCharter } from '../review-charter.js';
import { classifyDiff } from '../diff-classifier.js';

// ---------------------------------------------------------------------------
// #1134 T011 (US4 / SC-003)
//
// End-to-end harness proving the `speckit-bugfix` profile composes from existing
// public building blocks — with NO new agent-resolution path. It exercises, in
// one place:
//   - the verification review charter (US1) rendering the four bugfix questions,
//   - the targeted-validate command the classifier drives for the built-in
//     default (US2),
//   - the built-in `maxRemediations` cap of 2 for speckit-bugfix, and
//   - a workflow-scoped agent override picked up through the EXISTING
//     `resolveAgentForPhase(config, 'speckit-bugfix', 'review')` five-tier
//     precedence (#1095/#1122). No bugfix-specific resolver is introduced.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({ ...overrides });
}

describe('speckit-bugfix profile harness (#1134 T011)', () => {
  it('SC-003: verification charter + targeted validate + maxRemediations cap 2 compose for bugfix', () => {
    const config = makeConfig();
    const settings: OrchestratorSettings = {
      workflows: {
        'speckit-bugfix': {
          review: { profile: 'verification' },
        },
      },
    };

    // maxRemediations cap 2 (built-in, no override).
    const resolved = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');
    expect(resolved.maxRemediations).toBe(2);
    expect(resolved.review.profile).toBe('verification');

    // Verification charter renders the four bugfix questions.
    const charter = buildReviewCharter({
      profile: resolved.review.profile,
      sidecarRelPath: '.generacy/review-findings-x.json',
      blockingSeverity: resolved.review.blockingSeverity,
      round: 1,
    });
    expect(charter).toContain('Root cause vs symptom');
    expect(charter).toContain('Regression test present that fails without the fix');
    expect(charter).toContain('Scope creep');
    expect(charter).toContain('Regression risk in changed lines');

    // Targeted validate: built-in default + workspace + plain source → targeted.
    expect(config.validateCommand).toBe(DEFAULT_VALIDATE_COMMAND);
    const classification = classifyDiff({
      changedFiles: ['packages/a/src/x.ts'],
      isWorkspace: true,
    });
    expect(classification).toEqual({ kind: 'targeted' });
  });

  it('SC-003/US4: bugfix review agent resolves via the existing resolveAgentForPhase precedence', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-bugfix': {
            phases: {
              // Cheaper model for the bugfix review phase.
              review: { model: 'haiku-4-5', effort: 'low' },
            },
          },
        },
      },
    });

    // The workflow-scoped phase override is picked up through the SAME resolver
    // every other phase uses — no bugfix-specific resolution path.
    const agent = resolveAgentForPhase(config, 'speckit-bugfix', 'review');
    expect(agent.model).toBe('haiku-4-5');
    expect(agent.effort).toBe('low');

    // A different phase in the same workflow is unaffected (independent walk).
    const implementAgent = resolveAgentForPhase(config, 'speckit-bugfix', 'implement');
    expect(implementAgent.model).toBeUndefined();
  });
});
