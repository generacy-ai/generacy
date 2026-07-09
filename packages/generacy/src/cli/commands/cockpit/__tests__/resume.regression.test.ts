/**
 * FR-009 regression: end-to-end poll-path handoff.
 *
 * Given a `failed:validate` speckit-feature issue, invoking `runResume` must
 * produce a label set that:
 *   (a) satisfies the label-monitor's resume detection predicate — a
 *       `completed:<gate>` label paired with a matching `waiting-for:<gate>` —
 *       for the newly-added preceding-gate label pair.
 *   (b) causes `PhaseResolver.resolveStartPhase(labels, 'continue', 'speckit-feature')`
 *       to return `'validate'` — i.e. the worker re-enters the failed phase.
 *
 * The prior-phase `completed:<earlier-phase>` chain must be preserved untouched
 * (Q5 / spec Acceptance §3).
 */
import { describe, it, expect, vi } from 'vitest';
import { runResume } from '../resume.js';
import { PhaseResolver } from '@generacy-ai/orchestrator';
import type { GhWrapper } from '@generacy-ai/cockpit';

const baseLoad = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(async () => ({ url: '' })),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(async () => 'octocat'),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as GhWrapper;
}

const fixedNow = () => new Date('2026-07-09T12:00:00.000Z');

/**
 * Minimal replica of `LabelMonitorService.parseLabelEvent` for a `completed:*`
 * candidate: a resume event fires iff a matching `waiting-for:*` is also
 * present in the same label set. Constructing the service directly requires
 * many unrelated dependencies (queue manager, phase tracker, GH client
 * factory); the predicate itself is trivial and exercised end-to-end by
 * `parseLabelEvent` in the orchestrator's own tests.
 */
function monitorEmitsResumeEvent(
  labelName: string,
  issueLabels: string[],
): { type: 'resume'; gateName: string } | null {
  if (!labelName.startsWith('completed:')) return null;
  const gateName = labelName.slice('completed:'.length);
  if (!gateName) return null;
  const waitingLabel = `waiting-for:${gateName}`;
  if (!issueLabels.includes(waitingLabel)) return null;
  return { type: 'resume', gateName };
}

describe('cockpit resume — FR-009 end-to-end poll-path handoff', () => {
  it('failed:validate → post-resume set satisfies monitor + resolver → startPhase=validate', async () => {
    // Fixture: realistic failed:validate speckit-feature state after implement
    // phase produced a PR that failed review-then-validate.
    const inputLabels = [
      'workflow:speckit-feature',
      'failed:validate',
      'agent:error',
      'phase:validate',
      'completed:specify',
      'completed:clarify',
      'completed:plan',
      'completed:tasks',
      'completed:implement',
    ];

    const addedBatches: string[][] = [];
    const removedBatches: string[][] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: inputLabels })),
      addLabels: vi.fn(async (_nwo, _n, labels: string[]) => {
        addedBatches.push(labels);
      }),
      removeLabels: vi.fn(async (_nwo, _n, labels: string[]) => {
        removedBatches.push(labels);
      }),
    });

    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: () => {} },
    );

    // Reconstruct the terminal on-issue label set by applying additions then removals.
    const postResumeSet = new Set(inputLabels);
    for (const batch of addedBatches) {
      for (const label of batch) postResumeSet.add(label);
    }
    for (const batch of removedBatches) {
      for (const label of batch) postResumeSet.delete(label);
    }
    const postResumeLabels = Array.from(postResumeSet);

    // Monitor assertion (a): the newly-added completed:implementation-review
    // label paired with waiting-for:implementation-review yields a resume event.
    const event = monitorEmitsResumeEvent('completed:implementation-review', postResumeLabels);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('resume');
    expect(event!.gateName).toBe('implementation-review');

    // Resolver assertion (b): PhaseResolver picks validate as startPhase.
    const resolver = new PhaseResolver();
    const startPhase = resolver.resolveStartPhase(postResumeLabels, 'continue', 'speckit-feature');
    expect(startPhase).toBe('validate');

    // Q5 preservation: all prior-phase completed:* labels remain untouched.
    for (const preserved of [
      'completed:specify',
      'completed:clarify',
      'completed:plan',
      'completed:tasks',
      'completed:implement',
    ]) {
      expect(postResumeSet.has(preserved)).toBe(true);
    }

    // Failure surface cleared.
    expect(postResumeSet.has('failed:validate')).toBe(false);
    expect(postResumeSet.has('agent:error')).toBe(false);
    expect(postResumeSet.has('phase:validate')).toBe(false);

    // New triple present.
    expect(postResumeSet.has('waiting-for:implementation-review')).toBe(true);
    expect(postResumeSet.has('completed:implementation-review')).toBe(true);
    expect(postResumeSet.has('agent:paused')).toBe(true);
  });
});
