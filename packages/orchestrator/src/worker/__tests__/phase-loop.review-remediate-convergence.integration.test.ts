// #1168 (T040) — charter-contract test, reframed from the #1132 loop-composition
// suite (FR-009).
//
// US1's composed suite (`phase-loop.review-composed.integration.test.ts`) now
// owns the real composed-loop coverage: it drives the REAL ReviewExecutor under
// PhaseLoop via a spawning agent-CLI double and asserts verdict recomputation,
// severity gating, and the multi-round backtrack end-to-end. This file no longer
// re-drives the loop. It pins the two contracts the convergence path is built on
// — the ones a loop test cannot see because they are string/data shapes, not
// observable side-effects:
//
//   1. The review CHARTER shape the executor hands the agent each round:
//      - round 1 → whole-PR framing (no verification block), and
//      - round >= 2 → delta-scoped VERIFICATION framing (names only the changed
//        files, restricts new findings to blockingSeverity).
//   2. The `advanceArtifact` MERGE contract the engine applies when it folds a
//      re-review round into the artifact:
//      - an open finding whose file is in the delta and that the reviewer
//        re-emits as resolved transitions to resolved (convergence),
//      - an open finding NOT in the delta is carried forward untouched
//        (anti-vanish), and
//      - a sub-blocking NEW finding raised on a round >= 2 pass is DROPPED
//        (`filterNewFindings`).
//
// Parameterized over both workflows (`speckit-feature`, `speckit-bugfix`) with
// the per-workflow default blockingSeverity (feature → `major`, bugfix →
// `critical`) so the drop threshold is asserted at each workflow's real bar.
import { describe, it, expect } from 'vitest';
import { buildReviewCharter } from '../review-charter.js';
import { advanceArtifact, filterNewFindings } from '../review/findings-advance.js';
import { getReviewArtifactRelPath } from '../review-artifact.js';
import type { ReviewArtifact, ReviewFinding, Severity } from '../review-artifact.js';
import { deriveFindingId } from '../review-artifact.js';
import type { ReviewDelta } from '../review/review-delta.js';

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1132;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

// feature holds to a stricter blocking bar than a targeted bugfix (#1161 D3).
const BLOCKING_SEVERITY: Record<string, Severity> = {
  'speckit-feature': 'major',
  'speckit-bugfix': 'critical',
};

// A sub-blocking severity for each workflow — one rank below its blocking bar —
// so the round >= 2 advisory-drop assertion exercises the real threshold.
const SUB_BLOCKING_SEVERITY: Record<string, Severity> = {
  'speckit-feature': 'minor', // below `major`
  'speckit-bugfix': 'major', // below `critical`
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const file = overrides.file ?? 'src/a.ts';
  const title = overrides.title ?? 'blocking finding';
  return {
    id: deriveFindingId(file, title),
    severity: 'critical',
    file,
    title,
    detail: 'detail',
    round: 1,
    status: 'open',
    ...overrides,
    // keep id derived from the effective file/title even when those are overridden
    ...(overrides.id ? { id: overrides.id } : { id: deriveFindingId(file, title) }),
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'LAST',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

function delta(overrides: Partial<ReviewDelta> = {}): ReviewDelta {
  return {
    base: { source: 'last-reviewed', base: 'LAST', head: 'HEAD' },
    files: ['src/a.ts'],
    round: 2,
    ...overrides,
  };
}

describe.each([['speckit-feature'], ['speckit-bugfix']])(
  'review⇄remediate convergence — charter + merge contract (#1168 T040) [%s]',
  (workflowName) => {
    const blockingSeverity = BLOCKING_SEVERITY[workflowName]!;
    const subBlocking = SUB_BLOCKING_SEVERITY[workflowName]!;
    const sidecarRelPath = getReviewArtifactRelPath(WORKFLOW_ID);

    describe('review charter shape', () => {
      it('round 1 is whole-PR framed (no verification block)', () => {
        const charter = buildReviewCharter({
          profile: 'standard',
          sidecarRelPath,
          blockingSeverity,
          round: 1,
        });

        expect(charter).toContain('# Code review — round 1');
        // whole-PR framing, not delta/verification framing.
        expect(charter).toContain(
          'correctness and regression review of the changes on this pull request branch',
        );
        expect(charter).not.toContain('VERIFICATION re-review');
        expect(charter).not.toContain('Files changed since the last reviewed commit');
        // round-1 whole-PR pass flags an implausibly empty diff.
        expect(charter).toContain('## Empty or trivial diff');
        // FR-003: static review, never runs tests/builds.
        expect(charter).toContain('## Do NOT run tests or builds');
        // FR-005: names the exact sidecar write target + no-verdict instruction.
        expect(charter).toContain(sidecarRelPath);
        expect(charter).toContain('Do NOT include a verdict field');
      });

      it('round >= 2 is delta-scoped verification framed (names changed files, restricts new findings)', () => {
        const deltaFiles = ['src/a.ts', 'src/b.ts'];
        const charter = buildReviewCharter({
          profile: 'standard',
          sidecarRelPath,
          blockingSeverity,
          round: 2,
          verification: {
            prompt: 'Still-open findings to confirm:\n- src/a.ts — blocking finding',
            deltaFiles,
          },
        });

        expect(charter).toContain('# Code review — round 2');
        // verification framing — inspect ONLY the delta.
        expect(charter).toContain('VERIFICATION re-review');
        expect(charter).toContain('Files changed since the last reviewed commit:');
        for (const file of deltaFiles) {
          expect(charter).toContain(`- ${file}`);
        }
        // embeds the still-open-findings framing.
        expect(charter).toContain('Still-open findings to confirm:');
        // evidence-based resolution (re-emit with same file+title + resolved).
        expect(charter).toContain('## Confirming an addressed finding');
        // new findings restricted to blockingSeverity or higher on a re-review.
        expect(charter).toContain('## New findings on a verification pass');
        expect(charter).toContain(`severity \`${blockingSeverity}\``);
        // the round-1-only empty-diff block is absent on a verification pass.
        expect(charter).not.toContain('## Empty or trivial diff');
      });

      it('verification pass with an empty delta says "no files changed"', () => {
        const charter = buildReviewCharter({
          profile: 'standard',
          sidecarRelPath,
          blockingSeverity,
          round: 3,
          verification: { prompt: 'Confirm the fix.', deltaFiles: [] },
        });

        expect(charter).toContain('Delta since last review: no files changed.');
      });
    });

    describe('advanceArtifact merge contract', () => {
      it('resolves an open finding that is in the delta and re-emitted as resolved (convergence)', () => {
        const open = finding({ round: 1, status: 'open' });
        const prior = artifact({ findings: [open], round: 1 });
        const reviewerAddressed = [finding({ status: 'resolved', round: 2 })];

        const merged = advanceArtifact(
          prior,
          delta({ files: [open.file], round: 2 }),
          reviewerAddressed,
          [],
          blockingSeverity,
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]!.id).toBe(open.id);
        expect(merged[0]!.status).toBe('resolved');
      });

      it('carries an open finding forward untouched when its file is NOT in the delta (anti-vanish)', () => {
        const open = finding({ file: 'src/untouched.ts', title: 'stale blocker', round: 1 });
        const prior = artifact({ findings: [open], round: 1 });

        // reviewer addressed nothing and re-emitted nothing; the delta touches an
        // unrelated file. Silence must NOT close the finding.
        const merged = advanceArtifact(
          prior,
          delta({ files: ['src/other.ts'], round: 2 }),
          [],
          [],
          blockingSeverity,
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]!.id).toBe(open.id);
        expect(merged[0]!.status).toBe('open');
      });

      it('drops a sub-blocking NEW finding raised on a round >= 2 verification pass', () => {
        const prior = artifact({ findings: [], round: 1 });
        const advisory = finding({
          file: 'src/new.ts',
          title: 'nit: naming',
          severity: subBlocking,
          round: 2,
          status: 'open',
        });
        const blocker = finding({
          file: 'src/regression.ts',
          title: 'introduced regression',
          severity: blockingSeverity,
          round: 2,
          status: 'open',
        });

        const merged = advanceArtifact(
          prior,
          delta({ files: ['src/new.ts', 'src/regression.ts'], round: 2 }),
          [],
          [advisory, blocker],
          blockingSeverity,
        );

        // the sub-blocking advisory is filtered out; only the blocker survives.
        const ids = merged.map((f) => f.id);
        expect(ids).toContain(blocker.id);
        expect(ids).not.toContain(advisory.id);
      });

      it('filterNewFindings keeps all findings on round 1 but drops sub-blocking on round >= 2', () => {
        const advisory = finding({ severity: subBlocking, round: 1 });
        const blocker = finding({
          file: 'src/b.ts',
          title: 'blocker',
          severity: blockingSeverity,
          round: 1,
        });

        expect(filterNewFindings([advisory, blocker], 1, blockingSeverity)).toHaveLength(2);

        const round2 = filterNewFindings(
          [
            { ...advisory, round: 2 },
            { ...blocker, round: 2 },
          ],
          2,
          blockingSeverity,
        );
        expect(round2).toHaveLength(1);
        expect(round2[0]!.severity).toBe(blockingSeverity);
      });

      it('de-dupes a re-emitted open finding against the carried-forward prior (id uniqueness)', () => {
        const open = finding({ round: 1, status: 'open' });
        const prior = artifact({ findings: [open], round: 1 });

        // the agent re-emits the same finding as still-open on the verification
        // pass ("when in doubt"). It shares the prior's deterministic id, so the
        // merge must not append a duplicate.
        const reEmitted = finding({ round: 2, status: 'open' });

        const merged = advanceArtifact(
          prior,
          delta({ files: [open.file], round: 2 }),
          [],
          [reEmitted],
          blockingSeverity,
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]!.id).toBe(open.id);
        expect(merged[0]!.status).toBe('open');
      });
    });
  },
);
