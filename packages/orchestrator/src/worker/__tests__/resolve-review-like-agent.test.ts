import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema, DEFAULT_PROVIDER, resolveReviewLikeAgent } from '../config.js';
import type { WorkerConfig } from '../config.js';

/**
 * Agent-resolution matrix for the `review` / `remediate` phases (issue #1160, FR-005).
 *
 * `resolveReviewLikeAgent` prefers the `phases.<phase>` tier field-by-field and falls
 * back to the FULL `implement` resolution per field — so an operator who sets only
 * `phases.review.model` keeps the implement provider/effort. Remediate never consults
 * the `review` tier (Q3=A): its base is always the implement resolution, so a cheaper
 * review model cannot downgrade the code-writing remediate phase.
 */

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({ ...overrides });
}

describe('resolveReviewLikeAgent (issue #1160, FR-005)', () => {
  it('tier undefined → full implement agent', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
            },
          },
        },
      },
    });

    // No `phases.review` tier → inherit the implement resolution wholesale.
    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'review')).toEqual({
      provider: 'impl-provider',
      model: 'impl-model',
      effort: 'high',
    });
    // Same for remediate.
    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'remediate')).toEqual({
      provider: 'impl-provider',
      model: 'impl-model',
      effort: 'high',
    });
  });

  it('`model` only at the review tier → phase model + implement provider/effort', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
              review: { model: 'review-model' },
            },
          },
        },
      },
    });

    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'review')).toEqual({
      provider: 'impl-provider',
      model: 'review-model',
      effort: 'high',
    });
  });

  it('`provider` + `effort` at the review tier → phase provider/effort + implement model', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
              review: { provider: 'review-provider', effort: 'low' },
            },
          },
        },
      },
    });

    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'review')).toEqual({
      provider: 'review-provider',
      model: 'impl-model',
      effort: 'low',
    });
  });

  it('all three at the review tier → phase wins on every field', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
              review: { provider: 'review-provider', model: 'review-model', effort: 'low' },
            },
          },
        },
      },
    });

    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'review')).toEqual({
      provider: 'review-provider',
      model: 'review-model',
      effort: 'low',
    });
  });

  it('remediate never inherits the review tier (Q3=A)', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
              // A deliberately cheaper review model must NOT leak into remediate.
              review: { provider: 'review-provider', model: 'cheap-review-model', effort: 'low' },
            },
          },
        },
      },
    });

    // Remediate's base is the implement resolution; the review tier is ignored.
    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'remediate')).toEqual({
      provider: 'impl-provider',
      model: 'impl-model',
      effort: 'high',
    });
  });

  it('remediate uses its own phase tier when set', () => {
    const config = makeConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'impl-provider', model: 'impl-model', effort: 'high' },
              remediate: { model: 'remediate-model' },
            },
          },
        },
      },
    });

    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'remediate')).toEqual({
      provider: 'impl-provider',
      model: 'remediate-model',
      effort: 'high',
    });
  });

  it('no agents block at all → provider defaults, model + effort unset', () => {
    const config = makeConfig({});
    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'review')).toEqual({
      provider: DEFAULT_PROVIDER,
    });
    expect(resolveReviewLikeAgent(config, 'speckit-feature', 'remediate')).toEqual({
      provider: DEFAULT_PROVIDER,
    });
  });
});
